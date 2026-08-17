import { logger } from "../../logger.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { ApiContext } from "../context.js";
import type { ChatMessage, ApprovalRequestFrame } from "@mindcloud/shared";
import type { ApprovalRequest } from "../../core/agent-worker.js";
import type { LLMEvent } from "../../provider/types.js";
import { randomUUID } from "node:crypto";
import { getAuthToken, isTokenValid } from "../../config/auth-token.js";
import { isValidId, isAllowedWsOrigin, isApprovalRememberable, sanitizeInput, sanitizeDeltaEvent, extractWsToken } from "./validation.js";
import { isMcpToolName } from "../../tools/mcp/index.js";
import {
  auditAutoApproved,
  auditDecision,
  auditRemembered,
  auditRememberRejected,
  auditRequest,
  auditTimeout,
} from "../../plugins/approval-audit/index.js";

function safeSend(socket: WebSocket, data: string | object): void {
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    socket.send(payload);
  } catch (err) {
    logger.error({ err: err }, "failed to send websocket message");
  }
}

const APPROVAL_TIMEOUT_MS = 60_000;
const MAX_PENDING_MESSAGES = 100;

export async function registerWebSocketHandler(app: FastifyInstance, context: ApiContext) {
  app.get(
    "/ws/:agentId",
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const { agentId } = req.params as { agentId: string };
      const sessionId = (req.query as { sessionId?: string }).sessionId || "default";

      if (!isAllowedWsOrigin(req.headers.origin)) {
        socket.close(4403, "Forbidden origin");
        return;
      }

      // 握手鉴权：无凭证直接拒连（同机非浏览器进程的敞口由这里闭合）
      if (!isTokenValid(extractWsToken(req), await getAuthToken())) {
        socket.close(4401, "Unauthorized");
        return;
      }

      if (!isValidId(agentId)) {
        socket.close(4003, "Invalid agent id");
        return;
      }
      if (!isValidId(sessionId)) {
        socket.close(4004, "Invalid session id");
        return;
      }

      // message 监听必须在首个 await 之前同步注册：客户端在 onopen 后立即发送，
      // 若等 getAgentWorker 完成才注册，这期间到达的消息会被 ws 静默丢弃。
      // 与 session-handler.ts 同一模式（P1-8 起群聊同样串行化）：初始化期间
      // 先缓冲，ready 后按同一 chain 串行回放。
      const pendingMessages: unknown[] = [];
      let ready = false;
      // 串行处理消息，保证持久化与入队顺序
      let chain = Promise.resolve();
      // M30：ready 后 chain 深度同样要有上限——处理慢于到达时 promise 链会无限增长
      //（与 ready 前 pendingMessages 缓冲同口径，超限报错断连）
      let chainDepth = 0;

      function dispatch(raw: unknown): void {
        chainDepth += 1;
        chain = chain
          .then(() => handleMessage(raw))
          .catch((err) => {
            logger.error({ err: err }, "failed to handle websocket message");
            safeSend(socket, { type: "error", error: "Internal error" });
          })
          .finally(() => {
            chainDepth -= 1;
          });
      }

      socket.on("message", (raw: unknown) => {
        if (!ready) {
          if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
            safeSend(socket, { type: "error", error: "Too many pending messages" });
            socket.close();
            return;
          }
          pendingMessages.push(raw);
          return;
        }
        if (chainDepth >= MAX_PENDING_MESSAGES) {
          safeSend(socket, { type: "error", error: "Too many pending messages" });
          socket.close();
          return;
        }
        dispatch(raw);
      });

      const worker = await context.getAgentWorker(agentId);
      if (!worker) {
        socket.close(4001, "Agent not found");
        return;
      }
      /** 非 book 的 job 事件帧透出：sanitizeDeltaEvent 留在本层（P2 层间纪律——
       *  handoff 插件不 import api/*），经回调注入连接桥 */
      const sendJobEvent = (event: LLMEvent): void => {
        const safeEvent = sanitizeDeltaEvent(event);
        if (safeEvent) safeSend(socket, safeEvent);
      };

      // 换班续跑连接桥（P7b：建 loop / 注册进 registry / book 拦截 / 断连收尾
      // 收编进 handoff 插件）：控制面与注册表在 context.handoff 面；调度/打断
      // 只在私聊连接上生效（群聊多 Agent 槽位语义留边界外）。连接特有物
      // （发帧 / 历史加载 / worker 重新解析 / fallback worker）经回调注入。
      const handoffBridge = context.handoff?.attachConnection({
        agentId,
        sessionId,
        send: (frame) => safeSend(socket, frame),
        sendJobEvent,
        loadHistory: () =>
          context
            .getMessageRepository(agentId)
            .listBySession(sessionId, { limit: 20 })
            .catch(() => []),
        resolveWorker: () => context.getAgentWorker(agentId).catch(() => undefined),
        fallbackWorker: worker,
      });

      /** 单连接共享的 job 事件通道：有桥走桥（拦截 handoff.book 交续跑循环）；
       *  无桥（context.handoff 缺位的测试直构造路径）与原 handoffLoop 缺位
       *  同语义——book 帧吞掉不转发，其余帧 sanitize 后透出 */
      const emitJobEvent = (event: LLMEvent): void => {
        if (handoffBridge) {
          handoffBridge.onEvent(event);
          return;
        }
        if (event.type === "handoff.book") return;
        sendJobEvent(event);
      };

      // WS 连接生命周期（排查断连/1006 的关键路径日志）
      logger.info({ agentId, sessionId }, "[ws] 私聊连接建立");
      socket.on("close", (code: number, reason: Buffer) => {
        logger.info({ agentId, sessionId, code, reason: reason.toString() }, "[ws] 私聊连接关闭");
        // 断连统一走 registry 仲裁面（V3）：旧连接迟到 close 只取消本连接资源，
        // 只有无其他活跃连接时才落全局 record aborted（交接书仍在历史）
        handoffBridge?.detach();
      });

      // 危险工具审批：pending 表 + 本会话免询问名单（按连接维持）
      const pendingApprovals = new Map<
        string,
        { toolName: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }
      >();
      const autoApprovedTools = new Set<string>();

      function requestApproval(req: ApprovalRequest): Promise<boolean> {
        if (autoApprovedTools.has(req.toolName)) {
          auditAutoApproved({ agentId, sessionId, toolName: req.toolName });
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingApprovals.delete(req.id);
            auditTimeout({ agentId, sessionId, approvalId: req.id, toolName: req.toolName });
            resolve(false); // 超时视为拒绝
          }, APPROVAL_TIMEOUT_MS);
          pendingApprovals.set(req.id, { toolName: req.toolName, resolve, timer });
          auditRequest({
            agentId,
            sessionId,
            approvalId: req.id,
            toolCallId: req.toolCallId,
            toolName: req.toolName,
            args: req.arguments,
          });
          const frame: ApprovalRequestFrame = {
            type: "tool.approval_request",
            approvalId: req.id,
            toolCallId: req.toolCallId,
            toolName: req.toolName,
            arguments: req.arguments,
          };
          safeSend(socket, frame);
        });
      }

      socket.on("close", () => {
        for (const [id, pending] of pendingApprovals) {
          clearTimeout(pending.timer);
          pending.resolve(false);
          pendingApprovals.delete(id);
        }
      });

      ready = true;
      for (const raw of pendingMessages) dispatch(raw);
      pendingMessages.length = 0;

      async function handleMessage(raw: unknown): Promise<void> {
        try {
          const data = JSON.parse(String(raw));

          // 审批响应
          if (data.type === "tool.approval") {
            const pending = pendingApprovals.get(data.approvalId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingApprovals.delete(data.approvalId);
              const approved = data.approved === true;
              auditDecision({
                agentId,
                sessionId,
                approvalId: data.approvalId,
                toolName: pending.toolName,
                approved,
              });
              // MCP 工具名是动态的，进不了 shared 的 NO_REMEMBER 静态名单；
              // 第三方 server 的 annotations 不可信，mcp__ 前缀默认禁 remember，
              // 仅 server 配置 toolOverrides.allowRemember===true 放行（查询 McpClientManager）
              const rememberable =
                isApprovalRememberable(pending.toolName) &&
                (!isMcpToolName(pending.toolName) ||
                  (context.mcpManager?.isRememberAllowed(pending.toolName) ?? false));
              if (data.approved && data.remember && rememberable) {
                autoApprovedTools.add(pending.toolName);
                auditRemembered({ agentId, sessionId, toolName: pending.toolName });
              } else if (data.remember && !rememberable) {
                auditRememberRejected({ agentId, sessionId, toolName: pending.toolName });
              }
              pending.resolve(data.approved === true);
            }
            return;
          }

          // 带 type 的未知控制帧静默忽略（聊天消息不带 type），
          // 避免前端协议超前时穿透到聊天错误路径
          if (typeof data.type === "string") return;

          const input = sanitizeInput(data.text);
          if (!input.ok) {
            safeSend(socket, { type: "error", error: input.error });
            return;
          }

          // 用户消息 = abort 打断 + 新链签发：统一走 registry 仲裁面（桥内保持
          // 先 cancel 再 beginNewChain 的原调用序）——该 agent+session 维度下
          // 所有连接的 loop 一并取消（清定时器 + abort 在途 job）+ 全局 record
          // 标 aborted。不再存在「只扫本连接」的路径。F1：只在打断了在途活跃链时
          // 轮换代际，无活跃链沿用当前代际（P1-4：连发两条消息不误杀第一条的 book）
          const chainId = await handoffBridge?.cancelUserMessage();

          const userMessage: ChatMessage = {
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: input.text }],
            createdAt: new Date().toISOString(),
          };

          // Persist user message
          // M31：持久化失败即中止，不入队——否则新消息不在 agent 上下文中（答非所问）
          try {
            await context
              .getMessageRepository(agentId)
              .append({ ...userMessage, sessionId });
          } catch (err) {
            logger.error({ err: err }, "failed to persist user message");
            safeSend(socket, { type: "error", error: "Failed to persist message" });
            return;
          }

          // 加载最近历史作为上下文（含刚持久化的本条），与群聊行为一致
          const repo = context.getMessageRepository(agentId);
          const history = await repo.listBySession(sessionId, { limit: 20 }).catch(() => []);

          // P3-5（架构 review P1）：worker 不固化在连接上——配置变更后注册表
          // 里的 worker 会被 pause 并替换（bootstrap onChange），每条消息入队前
          // 重新解析；继续用连接建立时的引用会把消息塞进已 pause 的孤儿
          // worker（永不处理、无错误反馈）。常用路径只是 Map 查找，成本可忽略
          const worker = await context.getAgentWorker(agentId);
          if (!worker) {
            safeSend(socket, { type: "error", error: "Agent not found" });
            return;
          }

          worker.enqueue({
            id: randomUUID(),
            messages: history.length > 0 ? history : [userMessage],
            sessionId,
            onEvent:
              chainId !== undefined && handoffBridge
                ? (event) => handoffBridge.onEventWithChain(event, chainId)
                : emitJobEvent,
            onApprovalRequest: requestApproval,
          });
        } catch {
          safeSend(socket, { type: "error", error: "Invalid message" });
        }
      }
    }
  );
}

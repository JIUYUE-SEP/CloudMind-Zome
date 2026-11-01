import { logger } from "../../logger.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { routeMessage } from "../../conductor/conductor.js";
import type { ChatMessage, ApprovalRequestFrame } from "@cloudmind/shared";
import type { ApiContext } from "../context.js";
import { randomUUID } from "node:crypto";
import { getAuthToken, isTokenValid } from "../../config/auth-token.js";
import { isValidId, isAllowedWsOrigin, isApprovalRememberable, sanitizeInput, sanitizeDeltaEvent, extractWsToken } from "./validation.js";
import { isMcpToolName } from "../../tools/mcp/index.js";
import { isExternalToolName } from "../../tools/external/naming.js";
import {
  auditAutoApproved,
  auditDecision,
  auditRemembered,
  auditRememberRejected,
  auditRequest,
  auditTimeout,
} from "../../plugins/approval-audit/index.js";
import type { ApprovalRequest } from "../../core/agent-worker.js";

const MAX_PENDING_MESSAGES = 100;
const APPROVAL_TIMEOUT_MS = 60_000;

function safeSend(socket: WebSocket, data: string | object): void {
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    socket.send(payload);
  } catch (err) {
    logger.error({ err: err }, "failed to send websocket message");
  }
}

export async function registerSessionWebSocket(app: FastifyInstance, context: ApiContext) {
  app.get(
    "/ws/sessions/:sessionId",
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const { sessionId } = req.params as { sessionId: string };

      if (!isAllowedWsOrigin(req.headers.origin)) {
        socket.close(4403, "Forbidden origin");
        return;
      }

      // 握手鉴权：无凭证直接拒连（同机非浏览器进程的敞口由这里闭合）
      if (!isTokenValid(extractWsToken(req), await getAuthToken())) {
        socket.close(4401, "Unauthorized");
        return;
      }

      if (!isValidId(sessionId)) {
        socket.close(4004, "Invalid session id");
        return;
      }

      const pendingMessages: unknown[] = [];
      let session: Awaited<ReturnType<typeof context.sessionRepository.get>> = undefined;
      let ready = false;
      // 串行处理消息（P1-8）：与私聊 handler.ts 同一 promise chain 模式——
      // 同 session 消息排队（含回放），避免 m2 撞 worker 创建 I/O 先跑
      let chain = Promise.resolve();
      // M30：ready 后 chain 深度同样要有上限（与私聊 handler 同口径，超限报错断连）
      let chainDepth = 0;

      function dispatch(raw: unknown): void {
        chainDepth += 1;
        chain = chain
          .then(() => handleMessage(raw))
          .catch((err) => {
            logger.error({ err: err }, "failed to handle session websocket message");
            safeSend(socket, { type: "error", error: "Internal error" });
          })
          .finally(() => {
            chainDepth -= 1;
          });
      }

      // 危险工具审批：pending 表 + 本会话免询问名单（按连接维持，维度 agent+工具）
      const pendingApprovals = new Map<
        string,
        { agentId: string; toolName: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }
      >();
      const autoApprovedTools = new Set<string>();

      /**
       * 停止生成：本连接的在途 job 取消句柄。
       *
       * 群聊一条消息会同时投递给多个 target agent（各自 worker 并行），
       * 因此「停止」必须把整批一起掐掉——只掐一个，其余人形会继续在群里
       * 各说各话。作用域按连接：同 session 的另一个标签页不受影响。
       */
      const inflight = new Set<AbortController>();

      function requestApproval(agentId: string, req: ApprovalRequest): Promise<boolean> {
        const rememberKey = `${agentId}:${req.toolName}`;
        if (autoApprovedTools.has(rememberKey)) {
          auditAutoApproved({ agentId, sessionId, toolName: req.toolName });
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingApprovals.delete(req.id);
            auditTimeout({ agentId, sessionId, approvalId: req.id, toolName: req.toolName });
            resolve(false); // 超时视为拒绝
          }, APPROVAL_TIMEOUT_MS);
          // pending 记裸 toolName（P2-2）：免问资格判定必须看工具本身——
          // 复合键 "agentX:run_command" 永远不在 NO_REMEMBER_TOOLS 内，
          // guard 恒通过导致 run_command 在群聊可被 remember 免问（功能 M1）
          pendingApprovals.set(req.id, { agentId, toolName: req.toolName, resolve, timer });
          auditRequest({
            agentId,
            sessionId,
            approvalId: req.id,
            toolCallId: req.toolCallId,
            toolName: req.toolName,
            args: req.arguments,
          });
          const frame: ApprovalRequestFrame = {
            agentId,
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

      session = await context.sessionRepository.get(sessionId);
      if (!session) {
        socket.close(4002, "Session not found");
        return;
      }
      // WS 连接生命周期（排查断连/1006 的关键路径日志）
      logger.info({ sessionId }, "[ws] 群聊连接建立");
      socket.on("close", (code: number, reason: Buffer) => {
        logger.info({ sessionId, code, reason: reason.toString() }, "[ws] 群聊连接关闭");
      });
      ready = true;

      for (const raw of pendingMessages) {
        dispatch(raw);
      }
      // 与私聊 handler 同步：回放后清空缓冲，已入 chain 的消息不再滞留数组
      pendingMessages.length = 0;

      async function handleMessage(raw: unknown) {
        try {
          if (!session) return;
          const data = JSON.parse(String(raw));

          // 审批响应
          if (data.type === "tool.approval") {
            const pending = pendingApprovals.get(data.approvalId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingApprovals.delete(data.approvalId);
              const approved = data.approved === true;
              auditDecision({
                agentId: pending.agentId,
                sessionId,
                approvalId: data.approvalId,
                toolName: pending.toolName,
                approved,
              });
              // 资格判定用裸 toolName（NO_REMEMBER_TOOLS 按工具名排除），
              // 入名单仍按 agent+工具 维度，不误放同会话其他 agent；
              // MCP 工具（mcp__ 前缀）名动态且第三方 annotations 不可信，默认禁 remember，
              // 仅 server 配置 toolOverrides.allowRemember===true 放行（查询 McpClientManager）；
              // 外部插件工具（ext__ 前缀）同为动态第三方命名，默认禁 remember（无 override 通道，E3）
              const rememberable =
                isApprovalRememberable(pending.toolName) &&
                !isExternalToolName(pending.toolName) &&
                (!isMcpToolName(pending.toolName) ||
                  (context.mcpManager?.isRememberAllowed(pending.toolName) ?? false));
              if (data.approved && data.remember && rememberable) {
                autoApprovedTools.add(`${pending.agentId}:${pending.toolName}`);
                auditRemembered({ agentId: pending.agentId, sessionId, toolName: pending.toolName });
              } else if (data.remember && !rememberable) {
                auditRememberRejected({ agentId: pending.agentId, sessionId, toolName: pending.toolName });
              }
              pending.resolve(data.approved === true);
            }
            return;
          }

          // 停止生成（2026-11-01）：前端流式期间把发送按钮换成停止，点它发本帧。
          // 中断收尾由 P2 的 abort 语义统一负责（半截 step 不落盘、话题不入语义
          // 裁判、turn.end 带 aborted.reason="user"），这里只把信号打进在途 job。
          // 群聊是多 agent 并行，整批一起掐——否则被取消的人形停下、其余继续
          // 在群里发言，用户看到的是「点了停止但还在刷」。
          if (data.type === "turn.cancel") {
            for (const controller of inflight) controller.abort("user");
            inflight.clear();
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

          const userMessage: ChatMessage = {
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: input.text }],
            createdAt: new Date().toISOString(),
          };

          // M30：先解析成员 Agent——持久化只写仍存在的成员；给已删 agent 的仓库
          // append 会 mkdir 重建幽灵数据目录（持久化原先于 validAgents 过滤）
          const agents = await Promise.all(session.agentIds.map((id) => context.agentRepository.get(id)));
          const validAgents = agents.filter((a): a is NonNullable<typeof a> => !!a);

          // Save user message to all live agents in session (so each agent sees it in their context)
          for (const agent of validAgents) {
            const repo = context.getMessageRepository(agent.id);
            try {
              await repo.append({ ...userMessage, sessionId });
            } catch (err) {
              logger.error({ err: err }, "failed to persist user message");
              safeSend(socket, { type: "error", error: "Failed to persist message" });
            }
          }

          // Determine routing
          const routing = routeMessage(input.text, session, validAgents);

          // 空目标（如 @了不存在的成员、会话内 Agent 均已删除）时明确告知，
          // 而不是让消息静默消失
          if (routing.targetAgentIds.length === 0) {
            safeSend(socket, {
              type: "error",
              error: "没有可回复的 Agent：@提及未匹配到会话成员，或会话成员已失效",
            });
            return;
          }

          // Notify each target agent
          for (const agentId of routing.targetAgentIds) {
            const worker = await context.getAgentWorker(agentId);
            if (!worker) continue;

            // Load this agent's recent session messages as context
            // 读失败降级为空历史（与私聊 handler.ts / 连接桥 loadHistory 同口径）：
            // 单 agent 读失败只影响自身上下文，不饿死后续 target 入队
            const repo = context.getMessageRepository(agentId);
            const history = await repo.listBySession(sessionId, { limit: 20 }).catch(() => []);

            // 停止生成：本批 job 的取消句柄。onDone 无论成功/异常/中断都会触发，
            // 在那里释放，避免常驻连接上的 Set 无限增长
            const cancelHandle = new AbortController();
            inflight.add(cancelHandle);

            worker.enqueue({
              id: randomUUID(),
              messages: history,
              sessionId,
              signal: cancelHandle.signal,
              onDone: () => {
                inflight.delete(cancelHandle);
              },
              onEvent: (event) => {
                // handoff.book 帧吞掉不透传（与私聊连接桥拦截同口径）：群聊
                // 不续跑——多 Agent 槽位语义在换班边界外，撞顶只落交接书进历史，
                // 不调度下一棒，前端也无须消费该帧
                if (event.type === "handoff.book") return;
                // 与私聊 handler 同一校验：delta 帧只放行 string，脏帧丢弃
                const safeEvent = sanitizeDeltaEvent(event);
                if (safeEvent) safeSend(socket, { agentId, ...safeEvent });
              },
              onApprovalRequest: (req) => requestApproval(agentId, req),
            });
          }
        } catch (err) {
          safeSend(socket, { type: "error", error: String(err) });
        }
      }
    }
  );
}

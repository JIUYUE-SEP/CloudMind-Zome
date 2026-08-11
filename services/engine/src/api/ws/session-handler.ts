import { logger } from "../../logger.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs/promises";
import { routeMessage } from "../../conductor/conductor.js";
import type { ChatMessage, ApprovalRequestFrame, SessionModeChangedFrame } from "@mindcloud/shared";
import type { ApiContext } from "../context.js";
import { getDataDir } from "../../config/paths.js";
import { randomUUID } from "node:crypto";
import { getAuthToken, isTokenValid } from "../../config/auth-token.js";
import { isValidId, isValidChatMode, isValidProjectId, isAllowedWsOrigin, isApprovalRememberable, sanitizeInput, sanitizeDeltaEvent, extractWsToken } from "./validation.js";
import { isMcpToolName } from "../../tools/mcp/index.js";
import {
  auditAutoApproved,
  auditDecision,
  auditRemembered,
  auditRememberRejected,
  auditRequest,
  auditTimeout,
} from "./approval-audit.js";
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
      // 同 session 消息排队（含回放），避免 m2 撞 worker 创建 I/O 先跑、
      // set_mode 与消息交错取值不确定
      let chain = Promise.resolve();

      function dispatch(raw: unknown): void {
        chain = chain.then(() => handleMessage(raw)).catch((err) => {
          logger.error({ err: err }, "failed to handle session websocket message");
          safeSend(socket, { type: "error", error: "Internal error" });
        });
      }

      // 危险工具审批：pending 表 + 本会话免询问名单（按连接维持，维度 agent+工具）
      const pendingApprovals = new Map<
        string,
        { agentId: string; toolName: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }
      >();
      const autoApprovedTools = new Set<string>();

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
              // 仅 server 配置 toolOverrides.allowRemember===true 放行（查询 McpClientManager）
              const rememberable =
                isApprovalRememberable(pending.toolName) &&
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

          if (data.type === "session.set_mode") {
            const mode = data.mode as unknown;
            const projectId = data.projectId as unknown;

            if (!isValidChatMode(mode)) {
              safeSend(socket, { type: "error", error: "Invalid mode" });
              return;
            }

            if (projectId !== undefined && !isValidProjectId(projectId)) {
              safeSend(socket, { type: "error", error: "Invalid project id" });
              return;
            }

            const updatedSession = { ...session, mode, projectId };
            await context.sessionRepository.update(updatedSession);
            session = updatedSession;

            if (projectId) {
              const projectRoot = path.join(getDataDir(), "projects", projectId);
              await fs.mkdir(projectRoot, { recursive: true });
            }

            const frame: SessionModeChangedFrame = { type: "session.mode_changed", mode, projectId };
            safeSend(socket, frame);
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

          // Save user message to all agents in session (so each agent sees it in their context)
          for (const agentId of session.agentIds) {
            const repo = context.getMessageRepository(agentId);
            try {
              await repo.append({ ...userMessage, sessionId });
            } catch (err) {
              logger.error({ err: err }, "failed to persist user message");
              safeSend(socket, { type: "error", error: "Failed to persist message" });
            }
          }

          // Determine routing
          const agents = await Promise.all(session.agentIds.map((id) => context.agentRepository.get(id)));
          const validAgents = agents.filter((a): a is NonNullable<typeof a> => !!a);
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
            const repo = context.getMessageRepository(agentId);
            const history = await repo.listBySession(sessionId, { limit: 20 });

            const projectRoot = session.mode === "code" && session.projectId
              ? path.join(getDataDir(), "projects", session.projectId)
              : undefined;

            worker.enqueue({
              id: randomUUID(),
              messages: history,
              sessionId,
              mode: session.mode,
              projectRoot,
              onEvent: (event) => {
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

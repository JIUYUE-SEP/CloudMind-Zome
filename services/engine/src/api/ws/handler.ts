import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { ApiContext } from "../context.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { ApprovalRequest } from "../../core/agent-worker.js";
import { randomUUID } from "node:crypto";
import { isValidId, isAllowedWsOrigin, sanitizeInput } from "./validation.js";

function safeSend(socket: WebSocket, data: string | object): void {
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    socket.send(payload);
  } catch (err) {
    console.error("failed to send websocket message", err);
  }
}

const APPROVAL_TIMEOUT_MS = 60_000;

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

      if (!isValidId(agentId)) {
        socket.close(4003, "Invalid agent id");
        return;
      }
      if (!isValidId(sessionId)) {
        socket.close(4004, "Invalid session id");
        return;
      }

      const worker = await context.getAgentWorker(agentId);
      if (!worker) {
        socket.close(4001, "Agent not found");
        return;
      }
      // 函数声明会被提升，TS 无法在其中保留上面的收窄，这里固化一次
      const agentWorker = worker;

      // 危险工具审批：pending 表 + 本会话免询问名单（按连接维持）
      const pendingApprovals = new Map<
        string,
        { toolName: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }
      >();
      const autoApprovedTools = new Set<string>();

      function requestApproval(req: ApprovalRequest): Promise<boolean> {
        if (autoApprovedTools.has(req.toolName)) return Promise.resolve(true);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingApprovals.delete(req.id);
            resolve(false); // 超时视为拒绝
          }, APPROVAL_TIMEOUT_MS);
          pendingApprovals.set(req.id, { toolName: req.toolName, resolve, timer });
          safeSend(socket, {
            type: "tool.approval_request",
            approvalId: req.id,
            toolCallId: req.toolCallId,
            toolName: req.toolName,
            arguments: req.arguments,
          });
        });
      }

      socket.on("close", () => {
        for (const [id, pending] of pendingApprovals) {
          clearTimeout(pending.timer);
          pending.resolve(false);
          pendingApprovals.delete(id);
        }
      });

      // 串行处理消息，保证持久化与入队顺序
      let chain = Promise.resolve();
      socket.on("message", (raw: unknown) => {
        chain = chain.then(() => handleMessage(raw)).catch((err) => {
          console.error("failed to handle websocket message", err);
          safeSend(socket, { type: "error", error: "Internal error" });
        });
      });

      async function handleMessage(raw: unknown): Promise<void> {
        try {
          const data = JSON.parse(String(raw));

          // 审批响应
          if (data.type === "tool.approval") {
            const pending = pendingApprovals.get(data.approvalId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingApprovals.delete(data.approvalId);
              if (data.approved && data.remember) autoApprovedTools.add(pending.toolName);
              pending.resolve(data.approved === true);
            }
            return;
          }

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

          // Persist user message
          await context
            .getMessageRepository(agentId)
            .append({ ...userMessage, sessionId })
            .catch((err) => {
              console.error("failed to persist user message", err);
              safeSend(socket, { type: "error", error: "Failed to persist message" });
            });

          // 加载最近历史作为上下文（含刚持久化的本条），与群聊行为一致
          const repo = context.getMessageRepository(agentId);
          const history = await repo.listBySession(sessionId, { limit: 20 }).catch(() => []);

          agentWorker.enqueue({
            id: randomUUID(),
            messages: history.length > 0 ? history : [userMessage],
            sessionId,
            onEvent: (event) => {
              safeSend(socket, event);
            },
            onApprovalRequest: requestApproval,
          });
        } catch {
          safeSend(socket, { type: "error", error: "Invalid message" });
        }
      }
    }
  );
}

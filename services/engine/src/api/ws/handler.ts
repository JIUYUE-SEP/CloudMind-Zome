import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { ApiContext } from "../context.js";
import type { ChatMessage } from "@mindcloud/shared";
import { randomUUID } from "node:crypto";
import { isValidId, sanitizeInput } from "./validation.js";

export async function registerWebSocketHandler(app: FastifyInstance, context: ApiContext) {
  app.get(
    "/ws/:agentId",
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const { agentId } = req.params as { agentId: string };
      const sessionId = (req.query as { sessionId?: string }).sessionId || "default";

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

      socket.on("message", (raw: unknown) => {
        try {
          const data = JSON.parse(String(raw));
          const input = sanitizeInput(data.text);
          if (!input.ok) {
            socket.send(JSON.stringify({ type: "error", error: input.error }));
            return;
          }

          const userMessage: ChatMessage = {
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: input.text }],
            createdAt: new Date().toISOString(),
          };

          // Persist user message
          context.getMessageRepository(agentId).append({ ...userMessage, sessionId }).catch(() => {});

          worker.enqueue({
            id: randomUUID(),
            messages: [userMessage],
            sessionId,
            onEvent: (event) => {
              socket.send(JSON.stringify(event));
            },
          });
        } catch {
          socket.send(JSON.stringify({ type: "error", error: "Invalid message" }));
        }
      });
    }
  );
}

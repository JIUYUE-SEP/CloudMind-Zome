import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { ApiContext } from "../context.js";
import { routeMessage } from "../../conductor/conductor.js";
import type { ChatMessage } from "@mindcloud/shared";
import { randomUUID } from "node:crypto";
import { isValidId, sanitizeInput } from "./validation.js";

function safeSend(socket: WebSocket, data: string | object): void {
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    socket.send(payload);
  } catch (err) {
    console.error("failed to send websocket message", err);
  }
}

export async function registerSessionWebSocket(app: FastifyInstance, context: ApiContext) {
  app.get(
    "/ws/sessions/:sessionId",
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const { sessionId } = req.params as { sessionId: string };

      if (!isValidId(sessionId)) {
        socket.close(4004, "Invalid session id");
        return;
      }

      const pendingMessages: unknown[] = [];
      let session: Awaited<ReturnType<typeof context.sessionRepository.get>> = undefined;
      let ready = false;

      socket.on("message", (raw: unknown) => {
        if (!ready) {
          pendingMessages.push(raw);
          return;
        }
        void handleMessage(raw);
      });

      session = await context.sessionRepository.get(sessionId);
      if (!session) {
        socket.close(4002, "Session not found");
        return;
      }
      ready = true;

      for (const raw of pendingMessages) {
        void handleMessage(raw);
      }

      async function handleMessage(raw: unknown) {
        try {
          if (!session) return;
          const data = JSON.parse(String(raw));
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
              console.error("failed to persist user message", err);
              safeSend(socket, { type: "error", error: "Failed to persist message" });
            }
          }

          // Determine routing
          const agents = await Promise.all(session.agentIds.map((id) => context.agentRepository.get(id)));
          const validAgents = agents.filter((a): a is NonNullable<typeof a> => !!a);
          const routing = routeMessage(input.text, session, validAgents);

          // Notify each target agent
          for (const agentId of routing.targetAgentIds) {
            const worker = await context.getAgentWorker(agentId);
            if (!worker) continue;

            // Load this agent's recent session messages as context
            const repo = context.getMessageRepository(agentId);
            const history = await repo.listBySession(sessionId, { limit: 20 });

            worker.enqueue({
              id: randomUUID(),
              messages: history,
              sessionId,
              onEvent: (event) => {
                safeSend(socket, { agentId, ...event });
              },
            });
          }
        } catch (err) {
          safeSend(socket, { type: "error", error: String(err) });
        }
      }
    }
  );
}

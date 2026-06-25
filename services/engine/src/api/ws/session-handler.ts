import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { ApiContext } from "../context.js";
import { routeMessage } from "../../conductor/conductor.js";
import type { ChatMessage } from "@mindcloud/shared";
import { randomUUID } from "node:crypto";

export async function registerSessionWebSocket(app: FastifyInstance, context: ApiContext) {
  app.get(
    "/ws/sessions/:sessionId",
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const { sessionId } = req.params as { sessionId: string };
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
          const text = String(data.text || "");

          const userMessage: ChatMessage = {
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text }],
            createdAt: new Date().toISOString(),
          };

          // Save user message to all agents in session (so each agent sees it in their context)
          for (const agentId of session.agentIds) {
            const repo = context.getMessageRepository(agentId);
            await repo.append({ ...userMessage, sessionId });
          }

          // Determine routing
          const agents = await Promise.all(session.agentIds.map((id) => context.agentRepository.get(id)));
          const validAgents = agents.filter((a): a is NonNullable<typeof a> => !!a);
          const routing = routeMessage(text, session, validAgents);

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
              onEvent: (event) => {
                socket.send(JSON.stringify({ agentId, ...event }));
              },
            });
          }
        } catch (err) {
          socket.send(JSON.stringify({ type: "error", error: String(err) }));
        }
      }
    }
  );
}

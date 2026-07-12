import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs/promises";
import type { ApiContext } from "../context.js";
import { routeMessage } from "../../conductor/conductor.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { ChatMode } from "../../conductor/types.js";
import { getDataDir } from "../../config/paths.js";
import { randomUUID } from "node:crypto";
import { isValidId, sanitizeInput } from "./validation.js";

const MAX_PENDING_MESSAGES = 100;

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
          if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
            safeSend(socket, { type: "error", error: "Too many pending messages" });
            socket.close();
            return;
          }
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

          if (data.type === "session.set_mode") {
            const mode = data.mode as ChatMode;
            const projectId = data.projectId as string | undefined;
            session.mode = mode;
            session.projectId = projectId;
            await context.sessionRepository.update(session);
            if (projectId) {
              const projectRoot = path.join(getDataDir(), "projects", projectId);
              await fs.mkdir(projectRoot, { recursive: true });
            }
            safeSend(socket, { type: "session.mode_changed", mode, projectId });
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

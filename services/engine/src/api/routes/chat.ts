import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export async function registerChatRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/chat/:agentId/messages", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const { sessionId, limit } = request.query as { sessionId?: string; limit?: string };
    if (!sessionId) {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    const messages = await context.getMessageRepository(agentId).listBySession(sessionId, {
      limit: limit ? Number(limit) : undefined,
    });
    return messages;
  });
}

import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export async function registerChatRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/chat/:agentId/messages", {
    schema: {
      summary: "Get chat messages for an agent session",
      tags: ["chat"],
      querystring: {
        type: "object",
        properties: { sessionId: { type: "string" }, limit: { type: "string" } },
      },
    },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
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

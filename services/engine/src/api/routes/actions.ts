import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export async function registerActionRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/actions/:agentId", {
    schema: {
      summary: "List actions for an agent",
      tags: ["actions"],
      querystring: { type: "object", properties: { limit: { type: "string" }, offset: { type: "string" } } },
    },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!isValidAgentId(agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    return context.getActionRepository(agentId).list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });
}

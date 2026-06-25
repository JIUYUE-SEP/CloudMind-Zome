import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export async function registerMemoryRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/memory/:agentId", {
    schema: {
      summary: "List memories for an agent",
      tags: ["memory"],
      querystring: { type: "object", properties: { limit: { type: "string" }, offset: { type: "string" } } },
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    return context.getMemoryRepository(agentId).list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });

  app.get("/memory/:agentId/:id", {
    schema: { summary: "Get a memory by id", tags: ["memory"] },
  }, async (request, reply) => {
    const { agentId, id } = request.params as { agentId: string; id: string };
    const record = await context.getMemoryRepository(agentId).get(id);
    if (!record) return reply.status(404).send({ error: "Memory not found" });
    return record;
  });
}

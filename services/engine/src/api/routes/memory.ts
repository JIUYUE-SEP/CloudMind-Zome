import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export async function registerMemoryRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/memory/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    return context.getMemoryRepository(agentId).list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });

  app.get("/memory/:agentId/:id", async (request, reply) => {
    const { agentId, id } = request.params as { agentId: string; id: string };
    const record = await context.getMemoryRepository(agentId).get(id);
    if (!record) return reply.status(404).send({ error: "Memory not found" });
    return record;
  });
}

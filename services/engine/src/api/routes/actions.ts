import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export async function registerActionRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/actions/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    return context.getActionRepository(agentId).list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });
}

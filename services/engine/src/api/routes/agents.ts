import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import type { AgentConfig } from "@mindcloud/shared";

export async function registerAgentRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/agents", async () => {
    return context.agentRepository.list();
  });

  app.post("/agents", async (request, reply) => {
    const config = request.body as AgentConfig;
    if (!config.id) {
      return reply.status(400).send({ error: "id is required" });
    }
    await context.agentRepository.save(config.id, config);
    return config;
  });

  app.get("/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = await context.agentRepository.get(id);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    return config;
  });

  app.put("/agents/:id", async (request) => {
    const { id } = request.params as { id: string };
    const config = request.body as AgentConfig;
    await context.agentRepository.save(id, config);
    return config;
  });

  app.delete("/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await context.agentRepository.delete(id);
    return reply.status(204).send();
  });
}

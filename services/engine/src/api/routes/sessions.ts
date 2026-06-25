import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export async function registerSessionRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/sessions", async () => {
    return context.sessionRepository.list();
  });

  app.post("/sessions", async (request, reply) => {
    const body = request.body as { name: string; agentIds: string[]; type?: "group" | "intermind" };
    if (!body.name || !body.agentIds?.length) {
      return reply.status(400).send({ error: "name and agentIds required" });
    }
    return context.sessionRepository.create({
      name: body.name,
      agentIds: body.agentIds,
      type: body.type || "group",
    });
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    return session;
  });

  app.put("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; agentIds?: string[] };
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    if (body.name) session.name = body.name;
    if (body.agentIds) session.agentIds = body.agentIds;
    await context.sessionRepository.update(session);
    return session;
  });

  app.delete("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await context.sessionRepository.delete(id);
    return reply.status(204).send();
  });

  app.get("/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    const messages: unknown[] = [];
    for (const agentId of session.agentIds) {
      const repo = context.getMessageRepository(agentId);
      const agentMessages = await repo.listBySession(id, { limit: limit ? Number(limit) : 100 });
      messages.push(...agentMessages);
    }
    messages.sort((a, b) => new Date((a as { createdAt: string }).createdAt).getTime() - new Date((b as { createdAt: string }).createdAt).getTime());
    return messages;
  });
}

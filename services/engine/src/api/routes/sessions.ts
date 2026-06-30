import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export async function registerSessionRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/sessions", {
    schema: { summary: "List all sessions", tags: ["sessions"] },
  }, async () => {
    return context.sessionRepository.list();
  });

  app.post("/sessions", {
    schema: { summary: "Create a new session", tags: ["sessions"] },
  }, async (request, reply) => {
    const body = request.body as { name: string; agentIds: string[]; type?: "group" | "intermind" };
    if (!body.name || !body.agentIds?.length) {
      return reply.status(400).send({ error: "name and agentIds required" });
    }
    if (!body.agentIds.every(isValidAgentId)) {
      return reply.status(400).send({ error: "Invalid agent id in agentIds" });
    }
    return context.sessionRepository.create({
      name: body.name,
      agentIds: body.agentIds,
      type: body.type || "group",
    });
  });

  app.get("/sessions/:id", {
    schema: { summary: "Get a session by id", tags: ["sessions"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    return session;
  });

  app.put("/sessions/:id", {
    schema: { summary: "Update a session", tags: ["sessions"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; agentIds?: string[] };
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    if (body.agentIds && !body.agentIds.every(isValidAgentId)) {
      return reply.status(400).send({ error: "Invalid agent id in agentIds" });
    }
    if (body.name) session.name = body.name;
    if (body.agentIds) session.agentIds = body.agentIds;
    await context.sessionRepository.update(session);
    return session;
  });

  app.delete("/sessions/:id", {
    schema: { summary: "Delete a session", tags: ["sessions"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await context.sessionRepository.delete(id);
    return reply.status(204).send();
  });

  app.get("/sessions/:id/messages", {
    schema: {
      summary: "Get session messages",
      tags: ["sessions"],
      querystring: { type: "object", properties: { limit: { type: "string" } } },
    },
  }, async (request, reply) => {
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

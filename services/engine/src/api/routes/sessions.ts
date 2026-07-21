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

    const limitNum = limit ? Number(limit) : 100;
    const messages: unknown[] = [];
    // 用户消息会写入每个成员的仓库（见 session-handler），合并时按 id 去重
    const seen = new Set<string>();
    for (const agentId of session.agentIds) {
      const repo = context.getMessageRepository(agentId);
      const agentMessages = await repo.listBySession(id, { limit: limitNum });
      for (const msg of agentMessages) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        // assistant/tool 消息归属其所在仓库的 Agent，供前端展示发言人；user 消息不属于任何 Agent
        messages.push(msg.role === "user" ? msg : { ...msg, agentId });
      }
    }
    messages.sort((a, b) => new Date((a as { createdAt: string }).createdAt).getTime() - new Date((b as { createdAt: string }).createdAt).getTime());
    // limit 语义为总量（而非 per-agent 各 limit 条）：合并排序后截取最新的 limitNum 条
    return messages.slice(-limitNum);
  });
}

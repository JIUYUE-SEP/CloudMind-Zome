import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { isValidAgentId } from "@mindcloud/shared";
import { clampPageLimit } from "./pagination.js";

export async function registerSessionRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/sessions", {
    schema: { summary: "List all sessions", tags: ["sessions"] },
  }, async () => {
    return context.sessionRepository.list();
  });

  app.post("/sessions", {
    schema: { summary: "Create a new session", tags: ["sessions"] },
  }, async (request, reply) => {
    // M28：无 body/无 content-type 时 request.body 为 undefined，?? {} 兜底避免 TypeError 500（同 plans.ts 口径）
    const body = (request.body ?? {}) as { name: string; agentIds: string[]; type?: "group" | "intermind" };
    if (!body.name || !body.agentIds?.length) {
      return reply.status(400).send({ error: "name and agentIds required" });
    }
    if (!body.agentIds.every(isValidAgentId)) {
      return reply.status(400).send({ error: "Invalid agent id in agentIds" });
    }
    // type 白名单与 shared Session 类型（"group" | "intermind"）对齐，非法值 400 不落库
    if (body.type !== undefined && body.type !== "group" && body.type !== "intermind") {
      return reply.status(400).send({ error: "Invalid session type（只允许 group / intermind）" });
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
    const body = (request.body ?? {}) as { name?: string; agentIds?: string[] };
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    // 空数组成员显式 400：POST 拒绝空成员（:18），PUT 同样不允许置空破坏该不变量
    if (body.agentIds !== undefined && body.agentIds.length === 0) {
      return reply.status(400).send({ error: "agentIds must not be empty" });
    }
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
    // M32：删除不存在资源与 GET/PUT 同口径返回 404，不再恒 204
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
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

    // A5：limit=0/"abc"/-5 回落缺省 100，超上限封顶——slice(-0)=全量 路径消除
    const limitNum = clampPageLimit(limit);
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

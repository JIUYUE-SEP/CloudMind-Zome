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
      querystring: { type: "object", properties: { limit: { type: "string" }, before: { type: "string" } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit, before } = request.query as { limit?: string; before?: string };
    const session = await context.sessionRepository.get(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    // A5：limit=0/"abc"/-5 回落缺省 100，超上限封顶——slice(-0)=全量 路径消除
    const limitNum = clampPageLimit(limit);
    // before 游标（消息 id），语义与私聊端点（chat.ts）对齐：取游标之前的一页，
    // 游标本身不含；游标不存在于任何成员仓库时按无游标处理（不报错，仓储层
    // listBySessionWithArchived 未知游标同口径）。跨成员合并须先拿到游标
    // createdAt 再过滤：assistant 游标只存在于其所属成员的仓库，其余成员按未知
    // 游标返回尾部窗口，可能混入晚于游标的消息
    let beforeCreatedAt: string | undefined;
    if (before !== undefined) {
      for (const agentId of session.agentIds) {
        const repo = context.getMessageRepository(agentId);
        // 热存储 + 归档两侧都查（游标可能只存在于归档——话题压缩后热存储已清）；
        // 按 sessionId 过滤：getByIds/getArchivedByIds 不按会话过滤，其他会话的
        // 同 id 消息不能当本会话游标
        const hits = (await repo.getByIds([before]))
          .concat(await repo.getArchivedByIds([before]))
          .filter((m) => m.sessionId === id);
        if (hits.length > 0) {
          beforeCreatedAt = hits[0]!.createdAt;
          break;
        }
      }
    }
    const messages: unknown[] = [];
    // 用户消息会写入每个成员的仓库（见 session-handler），合并时按 id 去重
    const seen = new Set<string>();
    for (const agentId of session.agentIds) {
      const repo = context.getMessageRepository(agentId);
      // 跨热存储+归档读（与私聊 chat.ts 同方法）：「加载更早」要能翻进归档层。
      // before 逐成员透传：含游标的成员在仓储层截断，不含游标的成员按无游标
      // 返回尾部窗口，由下方 createdAt 过滤收口
      const agentMessages = await repo.listBySessionWithArchived(id, {
        limit: limitNum,
        ...(before !== undefined ? { before } : {}),
      });
      for (const msg of agentMessages) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        // assistant/tool 消息归属其所在仓库的 Agent，供前端展示发言人；user 消息不属于任何 Agent
        messages.push(msg.role === "user" ? msg : { ...msg, agentId });
      }
    }
    messages.sort((a, b) => new Date((a as { createdAt: string }).createdAt).getTime() - new Date((b as { createdAt: string }).createdAt).getTime());
    // 游标命中时只留早于游标的消息（严格小于：合并排序键只有 createdAt，同刻
    // 并列消息无法表达文件序，按排除处理）。游标消息本身天然不含：user 游标在
    // 每个成员仓库都被仓储层截断，assistant 游标只在所属成员仓库被截断。
    // 已知窗口边界：不含游标的成员若有多于 limitNum 条晚于游标的消息，其更早的
    // 消息会被该成员尾部窗口挤出（仓储层只支持 id 游标截窗）——极端
    // 密度差下本页条数偏少，但不会返回晚于游标的错误数据
    const page = beforeCreatedAt === undefined
      ? messages
      : messages.filter((m) => (m as { createdAt: string }).createdAt < beforeCreatedAt);
    // limit 语义为总量（而非 per-agent 各 limit 条）：合并排序后截取最新的 limitNum 条
    return page.slice(-limitNum);
  });
}

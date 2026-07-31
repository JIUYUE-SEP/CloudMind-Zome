import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

/** skill-history 查询上限（默认 50） */
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

export async function registerSkillRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/skills", {
    schema: { summary: "List available skills", tags: ["skills"] },
  }, async () => {
    return (await context.listSkills?.()) ?? [];
  });

  /**
   * hot reload（阶段 5 二期）：重载 agent 技能目录——复用配置变更的 worker
   * 退役/重建机制（下次使用时按新目录重建 L1），不做文件监听（留后续）
   */
  app.post("/agents/:agentId/skills/reload", {
    schema: { summary: "Reload agent skill catalog", tags: ["skills"] },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const config = await context.agentRepository.get(agentId);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    context.skillService?.invalidate(agentId); // 清解析缓存（否则 TTL 内目录仍是旧的）
    context.retireAgentWorker?.(agentId);
    return { ok: true, agentId, skills: (await context.skillService?.list(agentId)) ?? [] };
  });

  /** promptHistory（阶段 5 二期）：Skill 工具调用记录（倒序，最新在前） */
  app.get("/agents/:agentId/skill-history", {
    schema: { summary: "Get agent skill usage history", tags: ["skills"] },
  }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const config = await context.agentRepository.get(agentId);
    if (!config) return reply.status(404).send({ error: "Agent not found" });
    const raw = Number((request.query as { limit?: string }).limit);
    const limit = Math.min(
      Math.max(Number.isInteger(raw) && raw > 0 ? raw : HISTORY_DEFAULT_LIMIT, 1),
      HISTORY_MAX_LIMIT,
    );
    return (await context.skillService?.readHistory(agentId, limit)) ?? [];
  });
}

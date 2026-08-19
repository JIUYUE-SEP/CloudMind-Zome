import { logger } from "../../logger.js";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { isValidAgentId } from "@mindcloud/shared";
import { clampPageLimit, clampPageOffset } from "./pagination.js";
import {
  isValidTopicId,
  listCompressedTopics,
  readCompressedTopic,
  readCompressedTopicMsgIds,
  removeCompressedTopic,
} from "../../memory/topic/store.js";

/**
 * 话题压缩档审计接口（P4-d）：列表 / 单档全文 / 恢复。
 *
 * 恢复语义（已定决策「恢复即删档」）：把该档 msgIds 对应的消息从归档
 * （messages_archived.jsonl）写回热存储（messages.jsonl），随后删除压缩档——
 * 原文回热存储正常进 L3/L4，摘要不再与原文重复在场；归档行保留不动
 * （双轨各归其位）。重复 restore 已删档 → 404（幂等口径）。
 */
export async function registerTopicRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/agents/:id/topics", {
    schema: {
      summary: "List compressed topics for an agent",
      tags: ["topics"],
      querystring: { type: "object", properties: { limit: { type: "string" }, offset: { type: "string" } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    // 与 agents 路由 M32 同口径：agent 不存在显式 404（三端点统一）
    const agent = await context.agentRepository.get(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    // A5 同款 clamp：非法/0/负数回落缺省 100，上限 500 封顶；offset 非法回落 undefined
    return listCompressedTopics(id, {
      limit: clampPageLimit(limit),
      offset: clampPageOffset(offset),
    });
  });

  app.get("/agents/:id/topics/:topicId", {
    schema: { summary: "Get a compressed topic by id", tags: ["topics"] },
  }, async (request, reply) => {
    const { id, topicId } = request.params as { id: string; topicId: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    // topicId 作文件名段拼路径，白名单校验防路径穿越（store 内同一 regex）
    if (!isValidTopicId(topicId)) {
      return reply.status(400).send({ error: "Invalid topic id" });
    }
    const agent = await context.agentRepository.get(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const detail = await readCompressedTopic(id, topicId);
    if (!detail) return reply.status(404).send({ error: "Topic not found" });
    return detail;
  });

  app.post("/agents/:id/topics/:topicId/restore", {
    schema: { summary: "Restore a compressed topic's messages to hot storage", tags: ["topics"] },
  }, async (request, reply) => {
    const { id, topicId } = request.params as { id: string; topicId: string };
    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    if (!isValidTopicId(topicId)) {
      return reply.status(400).send({ error: "Invalid topic id" });
    }
    const agent = await context.agentRepository.get(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });

    // 与后台压缩任务的并发说明：同 agent 压缩队列串行；restore 读档早于压缩
    // 写档则 404，读档后归档尚未就绪则全缺 409（不动档，稍后重试可收敛）；
    // append 幂等 + 归档只增不减，交错下无消息丢失路径
    const msgIds = await readCompressedTopicMsgIds(id, topicId);
    if (msgIds === null) return reply.status(404).send({ error: "Topic not found" });
    if (msgIds.length === 0) {
      return reply.status(409).send({ error: "压缩档不含可恢复的消息记录", restored: 0, missing: 0 });
    }

    const repo = context.getMessageRepository(id);
    const archived = await repo.getArchivedByIds(msgIds);
    // 归档缺行口径：档引用了不在归档的 id 跳过并计数（missing）；全缺则 409 不动档
    if (archived.length === 0) {
      return reply.status(409).send({
        error: "归档中找不到该话题的任何消息记录（压缩档保留未动）",
        restored: 0,
        missing: msgIds.length,
      });
    }
    // 防重：已在热存储的 id 跳过（重复恢复/部分恢复重试安全）
    const inHot = new Set((await repo.getByIds(msgIds)).map((m) => m.id));
    const toRestore = archived
      .filter((m) => !inHot.has(m.id))
      // 按 createdAt 递增写回：append-only 热存储按到达序近似时间序，恢复段内部
      // 保序；段落落在文件尾——恢复原文进 L3 最近窗口是「恢复」的既定语义
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // 原子序：先写热存储再删档。append 中途抛错 → 500 且档保留，重试幂等
    // （已写回的 id 下轮被防重跳过）；不出现「档没了原文没回来」
    for (const record of toRestore) {
      await repo.append(record);
    }
    const missing = msgIds.length - archived.length;
    // 恢复即删档（已定决策）。removeCompressedTopic 是 best-effort（吞错误）：
    // 删除失败时档残留，最坏是 L5 摘要与原文暂时重复在场，重试 restore 可收敛
    await removeCompressedTopic(id, topicId);
    // 重索引配套（M14 镜像）：压缩归档时已 tombstone 这些消息的向量，不重新
    // 索引则恢复原文对 L4 语义检索永久不可见。对归档全集（含本次防重跳过的）
    // 重索引——覆盖「上次恢复写回成功但删档前重索引未完成」的重试收敛；
    // 钩子缺省（Mock embedder）/sidecar 不可用静默降级，与 indexTurnMessages
    // 同口径；实现侧 fire-and-forget，不阻断响应
    await context.reindexMessages?.(id, archived);
    logger.info(
      { agentId: id, topicId, restored: toRestore.length, missing },
      "[topic] 压缩档已恢复并删除",
    );
    return { restored: toRestore.length, missing };
  });
}

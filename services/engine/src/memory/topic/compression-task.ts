import { logger } from "../../logger.js";
import type { IMessageRepository } from "../repositories/types.js";
import type { LLMProvider } from "../../provider/types.js";
import { appendMindExperiences } from "../../mind/mind-files.js";
import { isInjectionSuspect } from "../../mind/injection-filter.js";
import { compressTopic } from "./compressor.js";
import { removeCompressedTopic, writeCompressedTopic } from "./store.js";
import type { TopicSegment } from "./types.js";

/**
 * 压缩任务执行体（P1-2 提取）：原 AgentWorker 压缩队列回调的共享实现，
 * 供 worker 后台队列与启动对账（reconcileOrphanedTopic）两条路径复用。
 */
export interface CompressionTaskDeps {
  agentId: string;
  provider: LLMProvider;
  /** 压缩模型（compressionModel || 主模型，调用方解析好） */
  model: string;
  messageRepository: IMessageRepository;
}

export async function runCompressionTask(
  segment: TopicSegment,
  deps: CompressionTaskDeps,
): Promise<void> {
  if (segment.archiveOnly) {
    // 短话题：不调用 LLM，仅归档，保证热存储有界
    await deps.messageRepository.archiveAndRemove(segment.messages.map((m) => m.id));
    return;
  }
  // 压缩失败不 fallback 主模型语义：异常由调用方（队列/对账）统一告警，原始消息留在热存储
  const compressed = await compressTopic(segment, deps.provider, deps.model);
  // 阶段 5 二期：话题内 Skill 使用清单随摘要落档（活跃保护——组装时自动重取依据）
  const enriched = segment.usedSkills?.length
    ? { ...compressed, usedSkills: segment.usedSkills }
    : compressed;
  // P2 review Major-3：摘要本体（主题/关键结论/正文）同样是持久化回流通道
  // （L5），落档前过与 MIND 沉淀同一注入检测——命中则降级为仅归档
  // （消息离开热存储进归档、不进 L5 回流），不再落档。误伤口径：讨论注入
  // 手法本身的话题可能被误降为仅归档（不丢消息、热存储有界性不变，接受）。
  const summaryText = [enriched.label, ...enriched.keyPoints, enriched.summary].join("\n");
  if (isInjectionSuspect(summaryText)) {
    logger.warn(`[topic] 压缩摘要命中注入检测，降级为仅归档（不落档）：${enriched.topicId}`);
    await deps.messageRepository.archiveAndRemove(enriched.msgIds);
    return;
  }
  await writeCompressedTopic(deps.agentId, enriched);
  // Phase 7：压缩落档成功后顺手沉淀经验到 MIND.md（append-only）。
  // 失败仅 warn 跳过，不影响压缩主流程
  if (compressed.experiences && compressed.experiences.length > 0) {
    try {
      await appendMindExperiences(
        deps.agentId,
        compressed.experiences.map((e) => ({
          ...e,
          source: `topic-${compressed.topicId}`,
          created: compressed.compressedAt,
        })),
      );
    } catch (err) {
      logger.warn({ err: err }, `[mind] 经验沉淀失败（已跳过）：${compressed.topicId}`);
    }
  }
  try {
    await deps.messageRepository.archiveAndRemove(compressed.msgIds);
  } catch (err) {
    // 归档失败而压缩档已生效会导致"摘要 + 原文"重复注入：
    // 隔离压缩档（消息留在热存储，由调用方告警记录），保证上下文不重复
    await removeCompressedTopic(deps.agentId, compressed.topicId);
    throw err;
  }
}

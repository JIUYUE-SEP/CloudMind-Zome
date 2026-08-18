import { logger } from "../../logger.js";
import type { IMessageRepository } from "../repositories/types.js";
import type { LLMProvider } from "../../provider/types.js";
import type { MindService } from "../../plugins/mind/index.js";
import { compressTopic } from "./compressor.js";
import { reviewTopicSegments } from "./judge.js";
import { removeCompressedTopic, writeCompressedTopic } from "./store.js";
import type { TopicSegment } from "./types.js";

/**
 * 压缩任务执行体（P1-2 提取）：原 AgentWorker 压缩队列回调的共享实现，
 * 供 worker 后台队列与启动对账（reconcileOrphanedTopic）两条路径复用。
 *
 * P4 inject 化：mind 能力（经验沉淀/注入检测）不再值级 import mind/ 模块，
 * 经 deps.mind 构造注入（解 memory→mind 包级值边），装配方从 ctx.mind 取下喂入。
 */
export interface CompressionTaskDeps {
  agentId: string;
  provider: LLMProvider;
  /** 压缩模型（compressionModel || 主模型，调用方解析好） */
  model: string;
  /** 裁判/复核模型链（boundaryModel || compressionModel || 主模型，调用方解析好） */
  boundaryModel?: string;
  messageRepository: IMessageRepository;
  /** mind 能力注入（P4）：经验沉淀 + 注入检测；类型复用 MindService（与源函数逐字一致），type-only 不算值边 */
  mind: Pick<MindService, "appendMindExperiences" | "isInjectionSuspect">;
  /**
   * 归档成功事件缝（P8b，memory/archived）：每次 archiveAndRemove 成功后
   * 调用（含仅归档降级路径）；可选——缺省不发事件。监听者抛错（invariants
   * enforce）按压缩任务失败上传（队列捕获告警、pending 段保留待对账）。
   */
  onArchived?: (ids: string[]) => void | Promise<void>;
}

export async function runCompressionTask(
  segment: TopicSegment,
  deps: CompressionTaskDeps,
): Promise<void> {
  if (segment.archiveOnly) {
    // 短话题：不调用 LLM，仅归档，保证热存储有界
    const ids = segment.messages.map((m) => m.id);
    await deps.messageRepository.archiveAndRemove(ids);
    // P8b 事件缝（memory/archived）：归档成功后发
    await deps.onArchived?.(ids);
    return;
  }
  // 压缩前复核（方案 C 六点定案 4，内嵌）：判单话题/多话题——多则拆成子段
  // 各自独立压缩落档（各一份压缩档）；复核失败/解析失败整段当单话题（现状，
  // 永不更差）。模型链：boundaryModel → compressionModel → 主模型。
  const subSegments = await reviewTopicSegments(
    segment,
    deps.provider,
    deps.boundaryModel ?? deps.model,
  );
  for (const sub of subSegments) {
    await compressAndArchiveSegment(sub, deps);
  }
}

/** 单段压缩落档 + 归档（复核拆分后每个子段各走一遍；原有单段路径语义不变） */
async function compressAndArchiveSegment(
  segment: TopicSegment,
  deps: CompressionTaskDeps,
): Promise<void> {
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
  if (deps.mind.isInjectionSuspect(summaryText)) {
    logger.warn(`[topic] 压缩摘要命中注入检测，降级为仅归档（不落档）：${enriched.topicId}`);
    await deps.messageRepository.archiveAndRemove(enriched.msgIds);
    // P8b 事件缝（memory/archived）：仅归档降级同样是归档成功
    await deps.onArchived?.(enriched.msgIds);
    return;
  }
  await writeCompressedTopic(deps.agentId, enriched);
  try {
    await deps.messageRepository.archiveAndRemove(compressed.msgIds);
  } catch (err) {
    // 归档失败而压缩档已生效会导致"摘要 + 原文"重复注入：
    // 隔离压缩档（消息留在热存储，由调用方告警记录），保证上下文不重复。
    // 此时经验尚未沉淀（M12：沉淀挪到归档成功之后），回滚后无孤儿经验残留
    await removeCompressedTopic(deps.agentId, compressed.topicId);
    throw err;
  }
  // Phase 7：归档成功后顺手沉淀经验到 MIND.md（append-only）。
  // M12：必须在归档成功之后——先沉淀再归档时，归档失败的回滚只隔离压缩档，
  // MIND.md 会留下孤儿经验，重启对账重压缩又沉淀一份（重复）。置于
  // onArchived 之前：事件监听抛错按任务失败上传时对账只见压缩档、只补归档，
  // 不会重压缩，经验不会重复沉淀。失败仅 warn 跳过，不影响压缩主流程
  if (compressed.experiences && compressed.experiences.length > 0) {
    try {
      await deps.mind.appendMindExperiences(
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
  // P8b 事件缝（memory/archived）：放在归档 try/catch 之外——归档已成功，
  // 事件监听抛错（invariants enforce）不按"归档失败"隔离压缩档，按压缩
  // 任务失败上传（队列告警、pending 段保留待对账）
  await deps.onArchived?.(compressed.msgIds);
}

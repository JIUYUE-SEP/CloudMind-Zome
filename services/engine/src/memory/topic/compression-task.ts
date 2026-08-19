import { logger } from "../../logger.js";
import { randomUUID } from "node:crypto";
import type { IMemoryRepository, IMessageRepository } from "../repositories/types.js";
import type { LLMProvider } from "../../provider/types.js";
import type { MindService } from "../../plugins/mind/index.js";
import { compressTopic } from "./compressor.js";
import { reviewTopicSegments } from "./judge.js";
import { removeCompressedTopic, writeCompressedTopic } from "./store.js";
import type { CompressedTopic, TopicSegment } from "./types.js";

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
  /**
   * 已归档消息向量的删除钩子（M14）：每次 archiveAndRemove 成功后按 msgIds
   * 删除 sidecar 向量（tombstone），向量索引不再随压缩无界增长。可选——
   * 缺省不删；监听者抛错仅 warn 降级，不按压缩任务失败上传（残留向量被
   * L4 归档排除兜住正确性，仅索引体积代价，与 onArchived 的强约束刻意不同）
   */
  deleteArchivedVectors?: (ids: string[]) => void | Promise<void>;
  /**
   * 长期记忆仓库（P4-a memory flush）：memories.jsonl 的首个生产写入方。
   * 可选——缺省不 flush（对账补压缩路径不接，见 startup-reconcile）。
   * append 写库 + list 读既有（flush 前文本精确去重，见 flushMemoryFacts）。
   */
  memoryRepository?: Pick<IMemoryRepository, "append" | "list">;
  /**
   * flush 条目的向量索引钩子（P4-a）：归档成功后逐条 embed 入索引
   * （doc_id `mem:<recordId>`，L4 可召回——flush 的核心价值：关键信息不依赖摘要保留）。
   * 无索引器（Mock embedder）时不挂钩子——**写库照做、只跳过向量**
   * （memories.jsonl 本身是文档存储，无向量也有审计/REST 可见性）；
   * sidecar 不可用由 indexer 内部静默降级。抛错仅 warn，不炸压缩主流程。
   */
  indexMemory?: (recordId: string, text: string) => void | Promise<void>;
}

/** M14：归档成功后删除对应向量；失败仅 warn，不炸压缩主流程 */
async function deleteArchivedVectors(deps: CompressionTaskDeps, ids: string[]): Promise<void> {
  if (!deps.deleteArchivedVectors) return;
  try {
    await deps.deleteArchivedVectors(ids);
  } catch (err) {
    logger.warn({ err: err }, "[memory] 已归档消息向量删除失败（已跳过，不阻断压缩）");
  }
}

/**
 * P4-a memory flush：归档成功后才把长期记忆事实落 memories.jsonl + 向量索引
 * （M12 同型纪律——先 flush 再归档时归档失败会留孤儿事实；置于归档成功后即无孤儿）。
 * 置信度 ≤ 0.5 不落盘（与 MIND 经验同口径）；置信度随 MemoryRecord 落盘供审计。
 * 逐条独立——单条失败仅 warn 跳过，不影响其余条目与压缩主流程。
 * 写库失败的条目不再索引（无库记录的向量是幽灵）。
 *
 * 文本精确去重（R1）：本话题 facts 与库中既有 content 逐字重复则写库与索引都跳。
 * 防两条重复路径——① M13 队列重试：onArchived 抛错按任务失败上传，重试时
 * archiveAndRemove 第二次静默 no-op，flush 会整体重跑；② 重复压缩：同段内容
 * 再次压缩产出相同事实。去重读库失败按空集放行（fail-open：重复事实低害，
 * 且 list 挂了 append 多半也会挂、走既有的 warn 跳过）。
 */
async function flushMemoryFacts(
  deps: CompressionTaskDeps,
  compressed: CompressedTopic,
): Promise<void> {
  if (!deps.memoryRepository) return;
  const facts = (compressed.memoryFacts ?? []).filter((f) => f.confidence > 0.5);
  if (facts.length === 0) return;
  let existing: Set<string>;
  try {
    existing = new Set(
      (await deps.memoryRepository.list()).map((r) => r.content.trim()),
    );
  } catch (err) {
    logger.warn({ err: err }, `[memory] flush 去重读库失败，按无既有记忆放行：${compressed.topicId}`);
    existing = new Set();
  }
  for (const fact of facts) {
    if (existing.has(fact.text.trim())) continue;
    const recordId = `mem_${Date.now()}_${randomUUID().slice(0, 8)}`;
    try {
      await deps.memoryRepository.append({
        id: recordId,
        content: fact.text,
        embeddingId: `mem:${recordId}`,
        createdAt: compressed.compressedAt,
        confidence: fact.confidence,
      });
      // 同批内互重也去（循环内登记，下一轮回合即见）
      existing.add(fact.text.trim());
    } catch (err) {
      logger.warn({ err: err }, `[memory] flush 落库失败（已跳过该条）：${compressed.topicId}`);
      continue;
    }
    try {
      await deps.indexMemory?.(recordId, fact.text);
    } catch (err) {
      logger.warn({ err: err }, `[memory] flush 向量索引失败（已跳过该条）：${compressed.topicId}`);
    }
  }
}

export async function runCompressionTask(
  segment: TopicSegment,
  deps: CompressionTaskDeps,
): Promise<void> {
  if (segment.archiveOnly) {
    // 短话题：不调用 LLM，仅归档，保证热存储有界
    const ids = segment.messages.map((m) => m.id);
    await deps.messageRepository.archiveAndRemove(ids);
    // M14：归档成功后删除对应向量（tombstone）
    await deleteArchivedVectors(deps, ids);
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
    // M14：归档成功后删除对应向量（tombstone）
    await deleteArchivedVectors(deps, enriched.msgIds);
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
  // M14：归档成功后删除对应向量（tombstone）。置于沉淀/onArchived 之前：
  // 删除失败仅 warn 降级（见 helper），不改变后续两者的既有成败语义
  await deleteArchivedVectors(deps, compressed.msgIds);
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
  // P4-a memory flush：与经验沉淀同一位次（归档成功后、onArchived 之前）——
  // onArchived 监听抛错按任务失败上传时对账只见压缩档、只补归档不重压缩，
  // flush 不会重复。注入检测降级路径不到这里（摘要可疑则同次产出的事实同样可疑）
  await flushMemoryFacts(deps, enriched);
  // P8b 事件缝（memory/archived）：放在归档 try/catch 之外——归档已成功，
  // 事件监听抛错（invariants enforce）不按"归档失败"隔离压缩档，按压缩
  // 任务失败上传（队列告警、pending 段保留待对账）
  await deps.onArchived?.(compressed.msgIds);
}

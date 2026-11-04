import { logger } from "../logger.js";
import type { MemoryIndexer } from "../memory/indexer.js";
import type { IMemoryRepository, IMessageRepository } from "../memory/repositories/types.js";
import type { ChatMessageRecord } from "../memory/repositories/types.js";
import type { SemanticMemory } from "./layers.js";

export interface SemanticSearchConfig {
  /** 默认 true；false 时完全跳过检索（仍需 embedder + sidecar 才有效） */
  enabled: boolean;
  /** L4 注入条数上限，默认 10 */
  topK: number;
  /** 最低相关度（相似度 × 时间衰减），默认 0 不过滤 */
  minScore: number;
}

export const DEFAULT_SEMANTIC_SEARCH_CONFIG: SemanticSearchConfig = {
  enabled: true,
  topK: 10,
  minScore: 0,
};

/**
 * 配置归一：topK < 1 会让检索永远无结果，minScore 超出 [0,1] 无意义。
 */
export function normalizeSemanticSearchConfig(
  partial: Partial<SemanticSearchConfig> = {},
): SemanticSearchConfig {
  const config = { ...DEFAULT_SEMANTIC_SEARCH_CONFIG, ...partial };
  // NaN 会穿透一切比较（search(top_k=NaN) 到 gRPC 行为未定义）；非整数取整
  if (!Number.isFinite(config.topK) || config.topK < 1) {
    logger.warn(`[semantic] topK=${config.topK} 非法，已按默认 ${DEFAULT_SEMANTIC_SEARCH_CONFIG.topK} 处理`);
    config.topK = DEFAULT_SEMANTIC_SEARCH_CONFIG.topK;
  }
  config.topK = Math.floor(config.topK);
  if (!Number.isFinite(config.minScore) || config.minScore < 0) config.minScore = 0;
  if (config.minScore > 1) config.minScore = 1;
  return config;
}

/**
 * 分段时间衰减（设计决策 5）：
 * 一周内不衰减，一个月内 80%，三个月内 50%，三个月以上保底 30%。
 * 早期对话可能包含人格设定与共同经历，不应快速衰减。
 */
export function timeDecay(createdAt: string, now: number = Date.now()): number {
  const days = (now - Date.parse(createdAt)) / 86_400_000;
  if (!Number.isFinite(days) || days < 7) return 1.0;
  if (days < 30) return 0.8;
  if (days < 90) return 0.5;
  return 0.3;
}

/** 与索引侧一致的注入截断（indexer.ts MAX_INDEX_CHARS）：tool 大文本不会全量进 L4 */
const MAX_INJECT_CHARS = 2000;

function recordText(record: ChatMessageRecord): string {
  return record.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim()
    .slice(0, MAX_INJECT_CHARS);
}

/**
 * L4 语义检索器（Phase 3 从 agent-worker 迁入）：
 * embedder + sidecar HNSW 仍由 MemoryIndexer 承载，本类负责
 * 候选获取 → 去重 → 归档排除 → 时间衰减打分 → minScore 过滤 → topK。
 *
 * P5：归档 id 查询能力（memory/topic/store.archivedMessageIds）改构造注入——
 * context/ 对 memory/ 的值级 import 切断（残余边处理，装配方从 memory 域取下喂入）。
 */
export class SemanticRetriever {
  constructor(
    private indexer: MemoryIndexer,
    private repo: IMessageRepository,
    private config: SemanticSearchConfig,
    /** 已压缩话题原文 id 查询（构造注入，原值级 import memory/topic/store 已切） */
    private archivedIds: (agentId: string) => Promise<Set<string>>,
    /**
     * P4-a flush 事实仓库（可选）：索引命中 `mem:<recordId>` 时按 id 回读
     * memories.jsonl 解析注入内容。缺省时 mem: 命中静默跳过（不炸检索主链路）。
     */
    private memoryRepo?: Pick<IMemoryRepository, "get">,
  ) {}

  /**
   * @param excludeIds 当前历史已含的消息 id（不重复注入）
   * @param currentSourceId 当前场景；跨场景命中会标注 source
   */
  async retrieve(
    agentId: string,
    query: string,
    excludeIds: Set<string>,
    currentSourceId: string,
  ): Promise<SemanticMemory[]> {
    if (!this.config.enabled || !query.trim()) return [];

    // 候选放大一倍：去重/归档/分数过滤后仍有机会补足 topK
    const hits = await this.indexer.search(agentId, query, this.config.topK * 2);
    const candidateIds = hits.map((h) => h.id).filter((id) => !excludeIds.has(id));
    if (candidateIds.length === 0) return [];
    const simById = new Map(hits.map((h) => [h.id, h.score] as const));

    // P4-a：候选分两类——消息 id 走消息仓库；`mem:<recordId>` 是压缩 flush 的
    // 长期记忆事实（向量 doc_id 约定），走 memories.jsonl 仓库解析。
    // 归档排除（archivedIds）只按消息 id 比对，天然不误伤 mem: 条目
    const msgIds = candidateIds.filter((id) => !id.startsWith("mem:"));
    const memRecordIds = candidateIds
      .filter((id) => id.startsWith("mem:"))
      .map((id) => id.slice("mem:".length));

    const [records, archivedIds, memRecords] = await Promise.all([
      this.repo.getByIds(msgIds),
      // 已压缩话题的原文 id（压缩档 frontmatter 索引，不读 messages_archived.jsonl 全文）
      this.archivedIds(agentId),
      this.memoryRepo
        ? Promise.all(memRecordIds.map((id) => this.memoryRepo!.get(id)))
        : Promise.resolve([]),
    ]);

    const now = Date.now();
    const memories: SemanticMemory[] = [];
    for (const record of records) {
      // 已压缩话题的原始消息不进 L4：对应摘要在 L5，避免同一内容双重注入
      if (archivedIds.has(record.id)) continue;
      const content = recordText(record);
      if (!content) continue;
      // 准入看相似度、排序看混合分（设计决策 1-3）：把两件事拆开，否则
      // decay ≤ 0.5 时无论内容多相关都必然被 minScore 挡掉（30 天硬悬崖）
      const similarity = simById.get(record.id) ?? 0;
      if (similarity < this.config.minScore) continue;
      memories.push({
        id: record.id,
        content,
        similarity,
        score: similarity * timeDecay(record.createdAt, now),
        source: record.sessionId && record.sessionId !== currentSourceId ? record.sessionId : undefined,
        createdAt: record.createdAt,
      });
    }
    // P4-a：flush 事实条目与消息条目同一打分/过滤口径（相似度 × 时间衰减）。
    // MemoryRecord 无 sessionId，不标跨场景来源；id 用原始 recordId
    // （pipeline 去重键 `mem:${id}` 恰好与向量 doc_id 一致）
    // P4-b 差异化保留：importance=high 的 flush 条目时间衰减恒 1.0（设计决策 5
    // 的兑现落点——L4 中只有 flush 条目带 importance：消息向量条目来自消息，
    // 消息无 importance 来源，且所属话题一经压缩即被归档排除出 L4）
    for (const record of memRecords) {
      if (!record) continue;
      const content = record.content.trim().slice(0, MAX_INJECT_CHARS);
      if (!content) continue;
      const decay = record.importance === "high" ? 1.0 : timeDecay(record.createdAt, now);
      // 与消息路径同口径：相似度判准入、混合分只排序（high 的衰减恒 1.0 语义不变）
      const similarity = simById.get(`mem:${record.id}`) ?? 0;
      if (similarity < this.config.minScore) continue;
      memories.push({ id: record.id, content, similarity, score: similarity * decay, createdAt: record.createdAt });
    }
    return memories.sort((a, b) => b.score - a.score).slice(0, this.config.topK);
  }
}

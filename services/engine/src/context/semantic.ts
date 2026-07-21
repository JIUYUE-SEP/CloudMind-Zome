import type { MemoryIndexer } from "../memory/indexer.js";
import type { IMessageRepository } from "../memory/repositories/types.js";
import type { ChatMessageRecord } from "../memory/repositories/types.js";
import { archivedMessageIds } from "../memory/topic/store.js";
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
  if (config.topK < 1) {
    console.warn(`[semantic] topK=${config.topK} 非法，已按默认 ${DEFAULT_SEMANTIC_SEARCH_CONFIG.topK} 处理`);
    config.topK = DEFAULT_SEMANTIC_SEARCH_CONFIG.topK;
  }
  if (config.minScore < 0) config.minScore = 0;
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

function recordText(record: ChatMessageRecord): string {
  return record.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

/**
 * L4 语义检索器（Phase 3 从 agent-worker 迁入）：
 * embedder + sidecar HNSW 仍由 MemoryIndexer 承载，本类负责
 * 候选获取 → 去重 → 归档排除 → 时间衰减打分 → minScore 过滤 → topK。
 */
export class SemanticRetriever {
  constructor(
    private indexer: MemoryIndexer,
    private repo: IMessageRepository,
    private config: SemanticSearchConfig,
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

    const [records, archivedIds] = await Promise.all([
      this.repo.getByIds(candidateIds),
      // 已压缩话题的原文 id（压缩档 frontmatter 索引，不读 messages_archived.jsonl 全文）
      archivedMessageIds(agentId),
    ]);

    const now = Date.now();
    const memories: SemanticMemory[] = [];
    for (const record of records) {
      // 已压缩话题的原始消息不进 L4：对应摘要在 L5，避免同一内容双重注入
      if (archivedIds.has(record.id)) continue;
      const content = recordText(record);
      if (!content) continue;
      const score = (simById.get(record.id) ?? 0) * timeDecay(record.createdAt, now);
      if (score < this.config.minScore) continue;
      memories.push({
        id: record.id,
        content,
        score,
        source: record.sessionId && record.sessionId !== currentSourceId ? record.sessionId : undefined,
        createdAt: record.createdAt,
      });
    }
    return memories.sort((a, b) => b.score - a.score).slice(0, this.config.topK);
  }
}

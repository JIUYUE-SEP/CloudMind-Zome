import type { ChatMessageRecord } from "@cloudmind/shared";
import type { IMessageRepository } from "./repositories/types.js";
import {
  listCompressedTopicMeta,
  readCompressedTopicMsgIds,
  type CompressedTopicMeta,
} from "./topic/store.js";

/** recall 分页常量（limit 硬上限防爆上下文） */
export const RECALL_DEFAULT_LIMIT = 20;
export const RECALL_MAX_LIMIT = 50;

export interface RecallPageOptions {
  limit?: number;
  offset?: number;
}

export interface RecallPage<T> {
  items: T[];
  total: number;
}

export interface RecallTopicItem {
  topicId: string;
  label: string;
  startedAt: string;
  endedAt: string;
  msgCount: number;
  sourceId: string;
}

export interface RecallMessageItem {
  id: string;
  role: ChatMessageRecord["role"];
  text: string;
  createdAt: string;
  sessionId: string;
}

function normalizeOptions(options?: RecallPageOptions): { limit: number; offset: number } {
  const rawLimit = Math.floor(options?.limit ?? RECALL_DEFAULT_LIMIT);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : RECALL_DEFAULT_LIMIT, 1),
    RECALL_MAX_LIMIT,
  );
  const rawOffset = Math.floor(options?.offset ?? 0);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  return { limit, offset };
}

function recordText(record: ChatMessageRecord): string {
  return record.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function toRecallMessage(record: ChatMessageRecord): RecallMessageItem {
  return {
    id: record.id,
    role: record.role,
    text: recordText(record),
    createdAt: record.createdAt,
    sessionId: record.sessionId,
  };
}

/**
 * 回忆服务（「上阁楼」）：只读本 agent 自己的压缩档元信息与归档原文。
 * 哲学：有损的在场（L5 摘要维持连续）+ 无损的可及（归档原文主动取回）——
 * 归档原文仍不被 L4 语义检索自动注入，回忆是她的主动行为。
 */
export class RecallService {
  constructor(private deps: { getMessageRepository(agentId: string): IMessageRepository }) {}

  /** 浏览记忆目录：压缩档元信息，按开始时间倒序，分页 */
  async listTopics(
    agentId: string,
    options?: RecallPageOptions,
  ): Promise<RecallPage<RecallTopicItem>> {
    const { limit, offset } = normalizeOptions(options);
    // 目录文件数有限：先取全量元信息（已按时间倒序），再分页拿总数
    const all: CompressedTopicMeta[] = await listCompressedTopicMeta(agentId);
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  /** 按话题取归档原文：msgIds 对应消息，按时间升序 */
  async readByTopicId(
    agentId: string,
    topicId: string,
    options?: RecallPageOptions,
  ): Promise<RecallPage<RecallMessageItem>> {
    const { limit, offset } = normalizeOptions(options);
    const ids = await readCompressedTopicMsgIds(agentId, topicId);
    if (!ids) throw new Error(`压缩档不存在：${topicId}`);
    const archived = await this.deps.getMessageRepository(agentId).getArchivedByIds(ids);
    const ordered = [...archived].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      items: ordered.slice(offset, offset + limit).map(toRecallMessage),
      total: ordered.length,
    };
  }

  /**
   * 按关键词过滤归档原文（大小写不敏感），命中按时间倒序分页。
   * 归档可能巨大：两遍流式扫描（先数总数定位窗口，再取窗口），内存 O(limit)。
   */
  async readByQuery(
    agentId: string,
    query: string,
    options?: RecallPageOptions,
  ): Promise<RecallPage<RecallMessageItem>> {
    const { limit, offset } = normalizeOptions(options);
    const needle = query.toLowerCase();
    const repo = this.deps.getMessageRepository(agentId);
    const match = (record: ChatMessageRecord) => recordText(record).toLowerCase().includes(needle);

    let total = 0;
    for await (const record of repo.listArchivedLazy()) {
      if (match(record)) total += 1;
    }
    if (total === 0 || offset >= total) return { items: [], total };

    // 倒序窗口：升序流中第 [total-offset-limit, total-offset) 个命中，最后反转
    const start = Math.max(0, total - offset - limit);
    const end = total - offset;
    let index = 0;
    const page: ChatMessageRecord[] = [];
    for await (const record of repo.listArchivedLazy()) {
      if (!match(record)) continue;
      if (index >= start && index < end) page.push(record);
      index += 1;
      if (index >= end) break;
    }
    page.reverse();
    return { items: page.map(toRecallMessage), total };
  }
}

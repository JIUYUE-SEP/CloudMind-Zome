import path from "node:path";
import { DocumentStore } from "../../plugins/memory/document-store.js";
import { getAgentDir, sanitizeAgentId } from "../../config/paths.js";
import type { ChatMessageRecord, IMessageRepository } from "./types.js";

export class MessageRepository implements IMessageRepository {
  constructor(private agentId: string) {
    sanitizeAgentId(agentId);
  }

  private store(): DocumentStore<ChatMessageRecord> {
    return new DocumentStore<ChatMessageRecord>(path.join(getAgentDir(this.agentId), "messages.jsonl"));
  }

  private archiveStore(): DocumentStore<ChatMessageRecord> {
    return new DocumentStore<ChatMessageRecord>(path.join(getAgentDir(this.agentId), "messages_archived.jsonl"));
  }

  async append(message: ChatMessageRecord): Promise<void> {
    await this.store().appendLine(message);
  }

  async listBySession(sessionId: string, options?: { limit?: number; before?: string }): Promise<ChatMessageRecord[]> {
    const all = await this.store().readLines();
    let filtered = all.filter((m) => m.sessionId === sessionId);
    if (options?.before) {
      const beforeIndex = filtered.findIndex((m) => m.id === options.before);
      // 游标命中首条（beforeIndex === 0）也要切出空页——原先按 > 0 判断，
      // 首条游标会落回全量窗口（review M37）；未命中（-1）按无游标处理，
      // 与 listBySessionWithArchived 的未知游标口径一致
      if (beforeIndex >= 0) filtered = filtered.slice(0, beforeIndex);
    }
    const limit = options?.limit ?? 100;
    return filtered.slice(-limit);
  }

  /**
   * session 首条用户消息（K1）：跨热存储+归档按 createdAt 时间序合并扫描，
   * 命中即停；内存与归档大小无关，不受 listBySession 最近 N 条窗口限制。
   */
  async firstUserMessageBySession(sessionId: string): Promise<ChatMessageRecord | undefined> {
    const aIt = this.archiveStore().readLinesLazy()[Symbol.asyncIterator]();
    const hIt = this.store().readLinesLazy()[Symbol.asyncIterator]();
    try {
      let a = await aIt.next();
      let h = await hIt.next();
      while (!a.done || !h.done) {
        const aRecord = a.done ? null : a.value;
        const hRecord = h.done ? null : h.value;
        let record: ChatMessageRecord;
        if (aRecord !== null && (hRecord === null || aRecord.createdAt <= hRecord.createdAt)) {
          record = aRecord;
          a = await aIt.next();
        } else {
          record = hRecord!;
          h = await hIt.next();
        }
        if (record.sessionId !== sessionId) continue;
        if (record.role === "user") return record;
      }
    } finally {
      await aIt.return?.();
      await hIt.return?.();
    }
    return undefined;
  }

  /**
   * 跨存储读（用户可见完整历史）：热存储 + 归档两条流按 createdAt 归并，
   * 只保留最近 limit 条的滚动窗口——内存与归档大小无关（归档可能远超
   * readLines 的 100MB 上限，这里逐行流式读、可提前 break）。
   *
   * 时间序前提：两个文件各自按 createdAt 递增追加（归档按热存储移除顺序追加，
   * 先归档后热存储）；同 createdAt 时归档优先。before 游标命中任一侧后，
   * 其前最近 limit 条即本页（未知游标按无游标处理，与 listBySession 同语义）。
   */
  async listBySessionWithArchived(
    sessionId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ChatMessageRecord[]> {
    const rawLimit = options?.limit;
    const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0 ? (rawLimit as number) : 100;
    const before = options?.before;
    const aIt = this.archiveStore().readLinesLazy()[Symbol.asyncIterator]();
    const hIt = this.store().readLinesLazy()[Symbol.asyncIterator]();

    // 滚动尾部窗口：只保留最近 limit 条，内存 O(limit)
    const tail: ChatMessageRecord[] = [];
    const push = (record: ChatMessageRecord) => {
      tail.push(record);
      if (tail.length > limit) tail.shift();
    };

    try {
      let a = await aIt.next();
      let h = await hIt.next();
      while (a.done === false || h.done === false) {
        // 三元先窄化：done 的返回侧没有 value（TS 对 AsyncGenerator 的
        // IteratorResult 判别窄化在此不作用于赋值，显式展开避免 union 残留）
        const aRecord = a.done ? null : a.value;
        const hRecord = h.done ? null : h.value;
        let record: ChatMessageRecord;
        if (aRecord !== null && (hRecord === null || aRecord.createdAt <= hRecord.createdAt)) {
          record = aRecord;
          a = await aIt.next();
        } else {
          record = hRecord!;
          h = await hIt.next();
        }
        if (record.sessionId !== sessionId) continue;
        // before 游标：其前已累积的滚动窗口即本页，游标之后的消息无关，提前停读
        if (before !== undefined && record.id === before) break;
        push(record);
      }
    } finally {
      await aIt.return?.();
      await hIt.return?.();
    }
    return tail;
  }

  async listBySessionPrefix(prefix: string): Promise<ChatMessageRecord[]> {
    const all = await this.store().readLines();
    return all.filter((m) => m.sessionId.startsWith(prefix));
  }

  async getByIds(ids: string[]): Promise<ChatMessageRecord[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    // 读缓存过滤读（review M9）：L4 每轮都按 id 取消息，全量 readLines 的
    // 整表深拷贝随历史线性放大；缓存命中时只深拷贝命中的少数记录。
    // 语义不变：按文件序返回、缺失 id 跳过、返回值不与缓存共享引用。
    return this.store().readLinesCachedWhere((m) => wanted.has(m.id));
  }

  async archiveAndRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const all = await this.store().readLines();
    const archived = all.filter((m) => wanted.has(m.id));
    if (archived.length === 0) return;
    // 先写归档再删热存储：归档成功前不动 messages.jsonl
    for (const record of archived) {
      await this.archiveStore().appendLine(record);
    }
    await this.store().mutateLines((records) => records.filter((m) => !wanted.has(m.id)));
  }

  async getArchivedByIds(ids: string[]): Promise<ChatMessageRecord[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    // 流式过滤读（review M10）：归档只增不减，终将超过 readLines 的 100MB 上限，
    // 而恢复路径必须在任意大小归档下可用；按 id 集合逐行过滤，内存与文件大小无关。
    return this.archiveStore().readLinesWhere((m) => wanted.has(m.id));
  }

  /** 惰性逐行读归档（recall 关键词过滤等全量扫描场景；内存与归档大小无关） */
  async *listArchivedLazy(): AsyncGenerator<ChatMessageRecord, void, void> {
    yield* this.archiveStore().readLinesLazy();
  }
}

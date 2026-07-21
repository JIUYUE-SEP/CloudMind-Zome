import path from "node:path";
import { DocumentStore } from "../document-store.js";
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
      if (beforeIndex > 0) filtered = filtered.slice(0, beforeIndex);
    }
    const limit = options?.limit ?? 100;
    return filtered.slice(-limit);
  }

  async getByIds(ids: string[]): Promise<ChatMessageRecord[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    const all = await this.store().readLines();
    return all.filter((m) => wanted.has(m.id));
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
    const all = await this.archiveStore().readLines();
    return all.filter((m) => wanted.has(m.id));
  }
}

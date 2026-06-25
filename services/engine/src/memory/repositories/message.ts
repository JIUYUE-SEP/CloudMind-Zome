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
}

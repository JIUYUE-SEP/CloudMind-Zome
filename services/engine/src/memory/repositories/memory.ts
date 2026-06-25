import path from "node:path";
import { DocumentStore } from "../document-store.js";
import { getAgentDir, sanitizeAgentId } from "../../config/paths.js";
import type { IMemoryRepository, MemoryRecord } from "./types.js";

export class MemoryRepository implements IMemoryRepository {
  constructor(private agentId: string) {
    sanitizeAgentId(agentId);
  }

  private store(): DocumentStore<MemoryRecord> {
    return new DocumentStore<MemoryRecord>(path.join(getAgentDir(this.agentId), "memories.jsonl"));
  }

  async append(record: MemoryRecord): Promise<void> {
    await this.store().appendLine(record);
  }

  async list(options?: { limit?: number; offset?: number }): Promise<MemoryRecord[]> {
    return this.store().readLines(options);
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const records = await this.store().readLines();
    return records.find((r) => r.id === id);
  }
}

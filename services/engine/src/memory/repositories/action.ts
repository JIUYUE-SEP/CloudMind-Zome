import path from "node:path";
import { DocumentStore } from "../../plugins/memory/document-store.js";
import { getAgentDir, sanitizeAgentId } from "../../config/paths.js";
import type { ActionRecord, IActionRepository } from "./types.js";

export class ActionRepository implements IActionRepository {
  constructor(private agentId: string) {
    sanitizeAgentId(agentId);
  }

  private store(): DocumentStore<ActionRecord> {
    return new DocumentStore<ActionRecord>(path.join(getAgentDir(this.agentId), "actions.jsonl"));
  }

  async append(record: ActionRecord): Promise<void> {
    await this.store().appendLine(record);
  }

  async list(options?: { limit?: number; offset?: number }): Promise<ActionRecord[]> {
    return this.store().readLines(options);
  }

  async get(id: string): Promise<ActionRecord | undefined> {
    const records = await this.store().readLines();
    return records.find((r) => r.id === id);
  }

  async update(record: ActionRecord): Promise<void> {
    await this.store().mutateLines((records) => {
      const index = records.findIndex((r) => r.id === record.id);
      if (index === -1) {
        throw new Error(`action not found: ${record.id}`);
      }
      records[index] = record;
      return records;
    });
  }
}

import path from "node:path";
import { DocumentStore } from "../document-store.js";
import { getAgentDir, sanitizeAgentId } from "../../config/paths.js";
import type { ILLMCallRepository, LLMCallRecord } from "./types.js";

export class LLMCallRepository implements ILLMCallRepository {
  constructor(private agentId: string) {
    sanitizeAgentId(agentId);
  }

  private store(): DocumentStore<LLMCallRecord> {
    return new DocumentStore<LLMCallRecord>(path.join(getAgentDir(this.agentId), "llm_calls.jsonl"));
  }

  async append(record: LLMCallRecord): Promise<void> {
    await this.store().appendLine(record);
  }

  async list(options?: { limit?: number; offset?: number }): Promise<LLMCallRecord[]> {
    return this.store().readLines(options);
  }
}

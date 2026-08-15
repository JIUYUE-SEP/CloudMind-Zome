import path from "node:path";
import { DocumentStore } from "../../plugins/memory/document-store.js";
import { getAgentDir, sanitizeAgentId } from "../../config/paths.js";
import type { ILLMCallRepository, LLMCallRecord } from "./types.js";

export class LLMCallRepository implements ILLMCallRepository {
  constructor(private agentId: string) {
    sanitizeAgentId(agentId);
  }

  // 增长说明（P4-5 接通后）：llm_calls.jsonl 是只增文件，与 P1-4 的
  // messages_archived.jsonl 同类——list() 走 readLines 有 100MB 硬上限，
  // 长年累月会重演 M10。当前无生产读取方（落档供离线排查），读取侧
  // 治理（轮转或 readLinesWhere 过滤读）留后续立项。
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

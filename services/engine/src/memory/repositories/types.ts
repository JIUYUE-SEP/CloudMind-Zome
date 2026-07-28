import type { AgentConfig, ToolCall } from "@mindcloud/shared";

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  embeddingId: string;
  createdAt: string;
}

export interface ActionRecord {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface LLMCallRecord {
  id: string;
  model: string;
  /** provider 返回 usage 时为真实值，拿不到（流式无 usage 或 mock）为 0（P4-5） */
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
  // —— P4-5 扩展字段（可选追加，v1 兼容不升版本）——
  /** 调用归属 */
  agentId?: string;
  provider?: string;
  /** 调用耗时（流式全程，毫秒） */
  durationMs?: number;
  status?: "ok" | "error";
  error?: string;
}

export interface IAgentRepository {
  get(agentId: string): Promise<AgentConfig | undefined>;
  save(agentId: string, config: AgentConfig): Promise<void>;
  delete(agentId: string): Promise<void>;
  list(): Promise<AgentConfig[]>;
}

export interface IMessageRepository {
  append(message: ChatMessageRecord): Promise<void>;
  listBySession(sessionId: string, options?: { limit?: number; before?: string }): Promise<ChatMessageRecord[]>;
  getByIds(ids: string[]): Promise<ChatMessageRecord[]>;
  /**
   * 话题压缩后的热存储清理：先把 ids 对应记录追加到 messages_archived.jsonl，
   * 再从 messages.jsonl 移除（先归档后删除，任何一步失败都不丢消息）。
   */
  archiveAndRemove(ids: string[]): Promise<void>;
  /** 从归档恢复（压缩档丢失时的最后防线） */
  getArchivedByIds(ids: string[]): Promise<ChatMessageRecord[]>;
}

export interface IMemoryRepository {
  append(record: MemoryRecord): Promise<void>;
  list(options?: { limit?: number; offset?: number }): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | undefined>;
}

export interface IActionRepository {
  append(record: ActionRecord): Promise<void>;
  list(options?: { limit?: number; offset?: number }): Promise<ActionRecord[]>;
  get(id: string): Promise<ActionRecord | undefined>;
  update(record: ActionRecord): Promise<void>;
}

export interface ILLMCallRepository {
  append(record: LLMCallRecord): Promise<void>;
  list(options?: { limit?: number; offset?: number }): Promise<LLMCallRecord[]>;
}

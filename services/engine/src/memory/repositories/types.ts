import type { AgentConfig, ChatMessageRecord } from "@mindcloud/shared";

export type { ChatMessageRecord };

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
  /** 真实 ProviderConfig.id（S5：llm_calls/usage 不再只记适配器名 openai/anthropic-messages） */
  providerId?: string;
  /** 真实 ProviderConfig.displayName（缺省回落 providerId/适配器名） */
  provider?: string;
  /** prompt+completion 合计（S5；历史旧记录无此字段，聚合不依赖） */
  totalTokens?: number;
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
  /**
   * 跨存储读（用户可见完整历史）：热存储 + 归档合并、按 createdAt 时间序，
   * limit/before 跨存储分页正确。归档可能巨大，实现必须流式/分段，
   * 内存与归档大小无关（"她的意识"路径——上下文组装/L4/reconcile/压缩——
   * 继续走 listBySession，不经此方法）。
   */
  listBySessionWithArchived(
    sessionId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ChatMessageRecord[]>;
  /** 按 sessionId 前缀扫描（Intermind 会话推导等场景；无前缀匹配返回空） */
  listBySessionPrefix(prefix: string): Promise<ChatMessageRecord[]>;
  getByIds(ids: string[]): Promise<ChatMessageRecord[]>;
  /**
   * 话题压缩后的热存储清理：先把 ids 对应记录追加到 messages_archived.jsonl，
   * 再从 messages.jsonl 移除（先归档后删除，任何一步失败都不丢消息）。
   */
  archiveAndRemove(ids: string[]): Promise<void>;
  /** 从归档恢复（压缩档丢失时的最后防线） */
  getArchivedByIds(ids: string[]): Promise<ChatMessageRecord[]>;
  /** 惰性逐行读归档（recall 关键词过滤等全量扫描场景；内存与归档大小无关） */
  listArchivedLazy(): AsyncGenerator<ChatMessageRecord, void, void>;
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

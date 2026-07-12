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
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
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

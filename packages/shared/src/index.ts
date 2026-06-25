export interface AgentConfig {
  id: string;
  name: string;
  persona: string;
  providerId?: string;
  modelId?: string;
  model?: string; // fallback for old configs
  skills: string[];
  tools: string[];
}

export interface ToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: string;
}

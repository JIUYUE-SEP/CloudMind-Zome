export interface AgentConfig {
  id: string;
  name: string;
  codename?: string;
  description?: string;
  persona: string;
  tags?: string[];
  representColor?: string;
  providerId?: string;
  modelId?: string;
  model?: string; // fallback for old configs
  embedderProviderId?: string;
  embedderModelId?: string;
  imageProviderId?: string;
  imageModelId?: string;
  temperature?: number;
  topP?: number;
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
  role: "user" | "assistant" | "tool" | "system";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: string;
}

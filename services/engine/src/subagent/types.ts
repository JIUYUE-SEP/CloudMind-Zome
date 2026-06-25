import type { ChatMessage } from "@mindcloud/shared";

export interface SubagentTask {
  id: string;
  parentAgentId: string;
  taskDescription: string;
  messages: ChatMessage[];
}

export interface SubagentResult {
  taskId: string;
  messages: ChatMessage[];
  error?: string;
}

export interface SubagentOptions {
  mode: "foreground" | "background";
  timeoutMs?: number;
}

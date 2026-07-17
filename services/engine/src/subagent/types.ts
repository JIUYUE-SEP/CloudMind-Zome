import type { ChatMessage } from "@mindcloud/shared";

export interface SubagentTask {
  id: string;
  parentAgentId: string;
  taskDescription: string;
  messages: ChatMessage[];
}

export interface SubagentResult {
  taskId: string;
  /** 子 agent 的最终文本输出 */
  output: string;
  error?: string;
}

export interface SubagentOptions {
  mode: "foreground" | "background";
  timeoutMs?: number;
}

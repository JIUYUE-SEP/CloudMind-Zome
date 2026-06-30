import type { ChatMessage } from "@mindcloud/shared";
import type { LLMEvent } from "../provider/types.js";

export interface ScheduledTask {
  id: string;
  agentId: string;
  description: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskJob {
  id: string;
  messages: ChatMessage[];
  sessionId?: string;
  onEvent: (event: LLMEvent) => void;
}

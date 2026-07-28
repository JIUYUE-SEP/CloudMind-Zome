import type { ChatMessage, ScheduledTask } from "@mindcloud/shared";
import type { LLMEvent } from "../provider/types.js";

export type { ScheduledTask };

export interface ScheduledTaskJob {
  id: string;
  messages: ChatMessage[];
  sessionId?: string;
  onEvent: (event: LLMEvent) => void;
}

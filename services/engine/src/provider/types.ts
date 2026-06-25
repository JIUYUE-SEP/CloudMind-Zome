import type { ChatMessage } from "@mindcloud/shared";

export interface TextDeltaEvent {
  type: "text.delta";
  delta: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking.delta";
  delta: string;
}

export interface ToolCallEvent {
  type: "tool.call";
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultEvent {
  type: "tool.result";
  toolCallId: string;
  output: unknown;
}

export interface StepEndEvent {
  type: "step.end";
  finishReason?: string;
}

export type LLMEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepEndEvent;

export interface LLMChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  name: string;
  chat(params: LLMChatParams): AsyncIterable<LLMEvent>;
  supportsModel(model: string): boolean;
}

export interface EmbedderProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
  supportsModel(model: string): boolean;
}

export interface ImageGenProvider {
  name: string;
  generate(
    prompt: string,
    options?: { size?: string }
  ): Promise<{ url?: string; data?: string }>;
  supportsModel(model: string): boolean;
}

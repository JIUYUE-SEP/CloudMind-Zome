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

/**
 * 一轮（turn）结束：由 runTurn 在 ReAct 循环退出后发出（含 maxSteps 耗尽）。
 * 与 step.end 区分——后者每个 loop step 都会发，tool_use 时循环继续；
 * 前端应只在 turn.end / error / close 时复位"生成中"状态。
 */
export interface TurnEndEvent {
  type: "turn.end";
}

export type LLMEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepEndEvent
  | TurnEndEvent;

export interface LLMChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  topP?: number;
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

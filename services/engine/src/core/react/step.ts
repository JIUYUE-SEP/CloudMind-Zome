import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent, LLMChatParams } from "../../provider/types.js";
import { runToolCallBatch, type ToolExecutionContext, type ToolCallRequest } from "./tool-call.js";
import { getTokenCounter } from "../../context/token-counter.js";
import {
  DEFAULT_MAX_TOOL_RESULT_TOKENS,
  truncateToolResultText,
} from "../../context/truncate.js";

export interface StepInput {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  toolCtx: ToolExecutionContext;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** 单条工具结果的 token 上限（review M1）；缺省 DEFAULT_MAX_TOOL_RESULT_TOKENS */
  maxToolResultTokens?: number;
}

export interface StepResult {
  stopReason: "stop" | "tool_use" | "max_tokens";
  assistantMessage: ChatMessage;
  toolMessages?: ChatMessage[];
  /** provider step.end 透传的 token 用量（改动三：水位判据的实测口径） */
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * 流式中断错误（P3-3，架构 review）：provider 流中途抛错时，已累积的部分
 * 生成内容（用户已上屏）构造成带 incomplete 标记的半截 assistant 消息随错误
 * 上抛，由 turn 层落盘——落盘内容与用户所见一致，模型后续上下文也知道这段。
 * toolCalls 一律不带：其 tool 结果从未执行，带上即成孤儿 toolCalls。
 */
export class StepStreamError extends Error {
  constructor(
    message: string,
    public readonly partialMessage: ChatMessage | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StepStreamError";
  }
}

export async function executeLoopStep(input: StepInput, emit: (event: LLMEvent) => void): Promise<StepResult> {
  const params: LLMChatParams = {
    model: input.model,
    messages: input.messages,
    tools: input.tools.length > 0 ? input.tools : undefined,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    topP: input.topP,
  };

  let textBuffer = "";
  let thinkBuffer = "";
  const toolCalls = new Map<string, ToolCallRequest>();
  let finishReason: string | undefined;
  let usage: { promptTokens: number; completionTokens: number } | undefined;

  try {
    for await (const event of input.provider.chat(params)) {
      emit(event);
      if (event.type === "step.end") {
        finishReason = event.finishReason;
        if (event.usage) usage = event.usage;
        continue;
      }
      switch (event.type) {
        case "text.delta":
          textBuffer += event.delta;
          break;
        case "thinking.delta":
          thinkBuffer += event.delta;
          break;
        case "tool.call": {
          toolCalls.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            name: event.name,
            arguments: event.arguments,
          });
          break;
        }
      }
    }
  } catch (err) {
    // P3-3：流式中断——半截内容不丢（构造 incomplete 半截消息随错误上抛）
    const partialContent: ChatMessage["content"] = [];
    if (textBuffer) partialContent.push({ type: "text", text: textBuffer });
    if (thinkBuffer) partialContent.push({ type: "think", think: thinkBuffer });
    const partialMessage: ChatMessage | undefined =
      partialContent.length > 0
        ? {
            id: `msg_${Date.now()}`,
            role: "assistant",
            content: partialContent,
            incomplete: true,
            createdAt: new Date().toISOString(),
          }
        : undefined;
    throw new StepStreamError(String(err), partialMessage, { cause: err });
  }

  const content: ChatMessage["content"] = [];
  if (textBuffer) content.push({ type: "text", text: textBuffer });
  if (thinkBuffer) content.push({ type: "think", think: thinkBuffer });

  const assistantMessage: ChatMessage = {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };

  if (toolCalls.size > 0) {
    assistantMessage.toolCalls = Array.from(toolCalls.values()).map((req) => ({
      toolCallId: req.toolCallId,
      name: req.name,
      arguments: req.arguments,
    }));
    const toolResults = await runToolCallBatch(Array.from(toolCalls.values()), input.toolCtx);
    // M1：工具结果落 context 前做 token 截断，防单步击穿窗口
    const counter = getTokenCounter();
    const maxToolResultTokens = input.maxToolResultTokens ?? DEFAULT_MAX_TOOL_RESULT_TOKENS;
    const toolMessages: ChatMessage[] = toolResults.map((r) => ({
      id: `tool_${r.toolCallId}`,
      role: "tool",
      content: [
        {
          type: "text",
          text: truncateToolResultText(
            typeof r.output === "string" ? r.output : JSON.stringify(r.output),
            maxToolResultTokens,
            counter,
          ),
        },
      ],
      toolCallId: r.toolCallId,
      createdAt: new Date().toISOString(),
    }));
    return {
      stopReason: "tool_use",
      assistantMessage,
      toolMessages,
      ...(usage ? { usage } : {}),
    };
  }

  const stopReason = finishReason === "length" ? "max_tokens" : "stop";
  return { stopReason, assistantMessage, ...(usage ? { usage } : {}) };
}

import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent, LLMChatParams } from "../../provider/types.js";
import { randomUUID } from "node:crypto";
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
  /** 外部取消信号：启动前与每个流式事件边界检查，中止即抛错（K2） */
  signal?: AbortSignal;
  /** 单条工具结果的 token 上限（review M1）；缺省 DEFAULT_MAX_TOOL_RESULT_TOKENS */
  maxToolResultTokens?: number;
  /**
   * LLM 请求钩子（P8b 事件缝，全链路可选）：provider.chat 发起前调用，
   * params 即请求本体引用（messages 同一数组，不落副本）；缺省零开销零行为
   * 变化。钩子抛错（invariants enforce 否决）原样上抛、本步不发起。
   */
  onLLMRequest?: (params: LLMChatParams) => Promise<void>;
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

/**
 * 工具结果序列化兜底（H7）：循环引用 / BigInt / toJSON 抛错会让 JSON.stringify
 * 裸调抛异常，整轮随之异常终止、已执行工具的结果全丢——击穿「单 call 隔离」
 * 承诺（见 tool-call.ts P3-2 注释）。失败回落为可读占位文本（失败说明 + 类型
 * 信息），保证单条工具结果永远能落成消息。
 */
function safeSerializeToolOutput(output: unknown): string {
  try {
    // undefined / 函数等 JSON.stringify 返回 undefined（非字符串），回落 String
    return JSON.stringify(output) ?? String(output);
  } catch {
    // String 对 null 原型对象/异常 toString 同样会抛，再兜一层只留类型信息
    try {
      return `[工具结果无法序列化] ${String(output)} (type: ${output === null ? "null" : typeof output})`;
    } catch {
      return `[工具结果无法序列化] (type: ${output === null ? "null" : typeof output})`;
    }
  }
}

export async function executeLoopStep(input: StepInput, emit: (event: LLMEvent) => void): Promise<StepResult> {
  if (input.signal?.aborted) throw new Error("aborted");
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

  // P8b 事件缝（llm/request）：钩子放在流式 try 之外——抛错原样上传，
  // 不被包成 StepStreamError 误标为流式中断（否决 ≠ 流中断）
  await input.onLLMRequest?.(params);

  try {
    for await (const event of input.provider.chat(params)) {
      if (input.signal?.aborted) throw new Error("aborted");
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
            id: `msg_${randomUUID()}`,
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
    id: `msg_${randomUUID()}`,
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
            typeof r.output === "string" ? r.output : safeSerializeToolOutput(r.output),
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

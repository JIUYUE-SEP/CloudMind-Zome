import type { ChatMessage } from "@cloudmind/shared";
import type { LLMProvider, LLMEvent, LLMChatParams } from "../../provider/types.js";
import { randomUUID } from "node:crypto";
import { executeLoopStep, type StepResult } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";
import { assistantText, isAbortError } from "./shared.js";

/** 撞顶兜底（真机实锤：连续工具调用后回合静默结束）：追加一次无工具总结的 system 提示 */
export const MAX_STEPS_SUMMARY_HINT =
  "工具调用步数已用完（异常空转保护），请根据已获得的信息直接给出最终回复，不要再调用工具";
/** 水位撞顶兜底（改动一）：语义为「水位撞顶」，与保险丝文案可区分 */
export const CONTEXT_WATERMARK_SUMMARY_HINT =
  "本轮上下文已接近窗口上限（水位撞顶），请根据已获得的信息直接给出最终回复，不要再调用工具";
/** 兜底总结也失败/空文本时的最终兜底回复——回合永远要有 assistant 回复，绝不静默 */
export const MAX_STEPS_FALLBACK_REPLY = "我查了很多资料但没能整理好答案，请再问我一次";
/** 水位撞顶兜底也失败/空文本时的最终兜底回复（与保险丝文案可区分） */
export const CONTEXT_WATERMARK_FALLBACK_REPLY =
  "本轮上下文已接近窗口上限，未能整理好答案，请再问我一次";
/** 空内容收尾兜底（M5）：空内容 stop 视同异常收尾时，追加无工具总结调用的 system 提示 */
export const EMPTY_STOP_SUMMARY_HINT =
  "本轮输出异常中断（空内容收尾），请根据已获得的信息直接给出最终回复，不要再调用工具";

export type SummaryReason = "max_steps" | "watermark" | "empty_stop";

/**
 * 兜底总结入参（D5 拆分：TurnInput 子集，结构兼容——调用方原样传 TurnInput；
 * 参数化显式传入，不反向 import turn.ts，防循环依赖）。
 */
export interface SummaryInput {
  provider: LLMProvider;
  model: string;
  toolCtx: ToolExecutionContext;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  onLLMRequest?: (params: LLMChatParams) => Promise<void>;
}

function makeFallbackReply(
  emit: (event: LLMEvent) => void,
  reason: SummaryReason = "max_steps",
): ChatMessage {
  const text = reason === "watermark" ? CONTEXT_WATERMARK_FALLBACK_REPLY : MAX_STEPS_FALLBACK_REPLY;
  const message: ChatMessage = {
    id: `msg_${randomUUID()}`,
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
  // 兜底文本不经 provider，需手动补流式帧，前端才不会空白等待
  emit({ type: "text.delta", delta: text });
  return message;
}

/**
 * 撞顶兜底总结调用：maxSteps 全部消耗在工具循环、水位撞顶（最后一次仍是
 * tool_use）或空内容 stop 收尾（M5）时，在 messages 尾部追加 system 提示、
 * tools 传空，强制模型产出最终文本。
 * 调用失败/违规工具调用/空文本 → 产出兜底回复文本（绝不静默）；
 * abort 除外——取消即中止，原样上抛（M3），不再降级兜底。
 */
export async function runMaxStepsSummary(
  input: SummaryInput,
  messages: ChatMessage[],
  maxToolResultTokens: number | undefined,
  emit: (event: LLMEvent) => void,
  reason: SummaryReason,
): Promise<ChatMessage> {
  const hintText =
    reason === "watermark"
      ? CONTEXT_WATERMARK_SUMMARY_HINT
      : reason === "empty_stop"
        ? EMPTY_STOP_SUMMARY_HINT
        : MAX_STEPS_SUMMARY_HINT;
  const hint: ChatMessage = {
    id: `msg_${randomUUID()}`,
    role: "system",
    content: [{ type: "text", text: hintText }],
    createdAt: new Date().toISOString(),
  };
  let result: StepResult;
  try {
    result = await executeLoopStep(
      {
        provider: input.provider,
        model: input.model,
        messages: [...messages, hint],
        // 不带工具：模型必须产出文本；即便模型违规发 tool.call，
        // 空工具表也只会得到 "Unknown tool" 错误结果（防御）
        tools: [],
        toolCtx: { ...input.toolCtx, tools: new Map() },
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        topP: input.topP,
        maxToolResultTokens,
        signal: input.signal,
        onLLMRequest: input.onLLMRequest,
      },
      emit,
    );
  } catch (err) {
    // M3：abort 不吞——取消即中止（原样上抛，换班链不再推进）；其他错误维持兜底语义
    if (isAbortError(err, input.signal)) throw err;
    return makeFallbackReply(emit, reason);
  }
  if (result.stopReason === "tool_use" || assistantText(result.assistantMessage).length === 0) {
    return makeFallbackReply(emit, reason);
  }
  return result.assistantMessage;
}

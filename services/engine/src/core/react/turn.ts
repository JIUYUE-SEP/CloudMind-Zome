import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent } from "../../provider/types.js";
import { executeLoopStep, StepStreamError, type StepInput, type StepResult } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  type AssembleInput,
  type ContextPipeline,
} from "../../context/pipeline.js";
import { TOOL_RESULT_BUDGET_RATIO } from "../../context/truncate.js";
import { getTokenCounter } from "../../context/token-counter.js";
import { stripUnansweredToolCalls } from "../../context/history-sanitize.js";

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

/**
 * 上下文水位主裁（改动一）：硬编码产品语义，不开放配置。
 * 0.7 = 提醒线：每回合至多追加一条 system 提醒后继续；0.9 = 撞顶线：跳出循环走兜底。
 */
const CONTEXT_WARN_RATIO = 0.7;
const CONTEXT_STOP_RATIO = 0.9;

type SummaryReason = "max_steps" | "watermark";

export interface TurnInput {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  toolCtx: ToolExecutionContext;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /**
   * 上下文窗口 W（改动一）：调用方按 agent 配置的 providerId + modelId 查型号表
   * 传入（改动三 helper）；缺省 80_000（与 pipeline 缺省同值）。
   */
  contextWindow?: number;
  /** 外部取消信号（如 subagent 前台超时）：在步骤边界检查并中止本轮 */
  signal?: AbortSignal;
  /**
   * ContextPipeline v2：存在时，本轮 messages/tools 先经 pipeline.assemble
   * 组装（含超预算降级），替换直接 messages 传递。
   */
  contextPipeline?: {
    pipeline: ContextPipeline;
    input: Omit<AssembleInput, "history" | "tools">;
  };
  /**
   * step 级落盘钩子（P1-6，review M8）：每完成一个 ReAct step（assistant 输出 +
   * 该步工具调用与结果）即以 [assistant, ...tools] 顺序回调一次。崩溃最多丢
   * 当前正在执行的 step，不再丢整轮。抛错即中止本轮（热存储只含完整 step）。
   * 水位 70% 提醒（system 消息）在插入时以单条回调一次，保证历史留痕。
   */
  onStepAppended?: (messages: ChatMessage[]) => Promise<void>;
}

export interface TurnResult {
  messages: ChatMessage[];
  assistantMessage: ChatMessage;
  toolMessages: ChatMessage[];
  /**
   * 本轮按序新增的全部消息（assistant + tool）。P1-6 起持久化由
   * onStepAppended 按 step 落盘，本字段仅供话题 tracker / 向量索引使用。
   * 水位 70% 提醒（system）也计入，随话题关闭归档。
   */
  appended: ChatMessage[];
}

function assistantText(message: ChatMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function makeFallbackReply(
  emit: (event: LLMEvent) => void,
  reason: SummaryReason = "max_steps",
): ChatMessage {
  const text = reason === "watermark" ? CONTEXT_WATERMARK_FALLBACK_REPLY : MAX_STEPS_FALLBACK_REPLY;
  const message: ChatMessage = {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
  // 兜底文本不经 provider，需手动补流式帧，前端才不会空白等待
  emit({ type: "text.delta", delta: text });
  return message;
}

/**
 * 撞顶兜底总结调用：maxSteps 全部消耗在工具循环或水位撞顶（最后一次仍是
 * tool_use）时，在 messages 尾部追加 system 提示、tools 传空，强制模型产出最终文本。
 * 调用失败/违规工具调用/空文本 → 产出兜底回复文本（绝不静默）。
 */
async function runMaxStepsSummary(
  input: TurnInput,
  messages: ChatMessage[],
  maxToolResultTokens: number | undefined,
  emit: (event: LLMEvent) => void,
  reason: SummaryReason,
): Promise<ChatMessage> {
  const hintText =
    reason === "watermark" ? CONTEXT_WATERMARK_SUMMARY_HINT : MAX_STEPS_SUMMARY_HINT;
  const hint: ChatMessage = {
    id: `msg_${Date.now()}`,
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
      },
      emit,
    );
  } catch {
    return makeFallbackReply(emit, reason);
  }
  if (result.stopReason === "tool_use" || assistantText(result.assistantMessage).length === 0) {
    return makeFallbackReply(emit, reason);
  }
  return result.assistantMessage;
}

/**
 * 水位 U（双口径取大）：实测 = provider step.end usage（权威回报）；
 * 估算 = 本地 token 计数（当前 messages，含刚追加的工具结果）。缺哪路用哪路。
 */
function contextUsedTokens(result: StepResult, messages: ChatMessage[]): number {
  const estimated = getTokenCounter().countMessages(messages);
  const measured =
    result.usage === undefined
      ? undefined
      : result.usage.promptTokens + result.usage.completionTokens;
  if (measured === undefined) return estimated;
  return Math.max(estimated, measured);
}

/** 70% 提醒 system 消息（每回合至多一条，文案含已用/窗口与收敛指引） */
function makeWatermarkReminder(used: number, window: number): ChatMessage {
  const pct = Math.round((used / window) * 100);
  return {
    id: `msg_${Date.now()}`,
    role: "system",
    content: [
      {
        type: "text",
        text:
          `[系统提醒] 本轮上下文已用约 ${pct}%（${used}/${window} tokens）。` +
          "请收敛工具调用、优先收尾；如任务未完成，先总结当前进展与下一步计划。",
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

export async function runTurn(
  input: TurnInput,
  emit: (event: LLMEvent) => void
): Promise<TurnResult> {
  // 半个 turn 清洗（P1-6）：历史里 assistant 带 toolCalls 但缺 tool 结果的
  // 残缺消息（崩溃/落盘失败遗留）先修平，避免孤儿 toolCalls 污染本轮及后续
  let messages = stripUnansweredToolCalls([...input.messages]);
  let tools = input.tools;

  // ContextPipeline v2：每轮统一组装（超预算自动降级）
  let maxToolResultTokens: number | undefined;
  if (input.contextPipeline) {
    const assembled = await input.contextPipeline.pipeline.assemble({
      ...input.contextPipeline.input,
      history: messages,
      tools,
    });
    messages = assembled.messages;
    tools = assembled.tools;
    // M1：步骤内工具结果也纳入预算约束——单条上限为预算的 20%
    maxToolResultTokens = Math.max(
      1,
      Math.floor(input.contextPipeline.pipeline.budgetTokens * TOOL_RESULT_BUDGET_RATIO),
    );
  }

  const maxSteps = input.maxSteps ?? 100;
  let assistantMessage: ChatMessage | undefined;
  const toolMessages: ChatMessage[] = [];
  const appended: ChatMessage[] = [];

  let step = 0;
  let watermarked = false; // 本回合已发过 70% 提醒（每回合最多一次）
  let watermarkStop = false; // 本回合已撞 90% 顶（跳出循环走兜底）
  for (; step < maxSteps; step++) {
    if (input.signal?.aborted) {
      throw new Error("aborted");
    }
    const stepInput: StepInput = {
      provider: input.provider,
      model: input.model,
      messages,
      tools,
      toolCtx: input.toolCtx,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      topP: input.topP,
      maxToolResultTokens,
    };

    let result: StepResult;
    try {
      result = await executeLoopStep(stepInput, emit);
    } catch (err) {
      // P3-3：流式中断的半截 assistant 消息随 StepStreamError 上来——
      // 先按 step 级落盘（与用户所见一致），再继续上抛
      // （worker catch 补错误文本与 turn.end 终帧，P3-1）
      if (err instanceof StepStreamError && err.partialMessage) {
        messages.push(err.partialMessage);
        appended.push(err.partialMessage);
        if (input.onStepAppended) {
          await input.onStepAppended([err.partialMessage]);
        }
      }
      throw err;
    }
    assistantMessage = result.assistantMessage;
    messages.push(result.assistantMessage);
    appended.push(result.assistantMessage);

    const stepMessages: ChatMessage[] = [result.assistantMessage];
    if (result.toolMessages) {
      messages.push(...result.toolMessages);
      toolMessages.push(...result.toolMessages);
      appended.push(...result.toolMessages);
      stepMessages.push(...result.toolMessages);
    }

    // step 级落盘（P1-6）：assistant 与其 tool 结果同批回调，崩溃只丢当前
    // 执行中的 step；落盘失败中止本轮，热存储不留缺 tool 结果的半截 step
    if (input.onStepAppended) {
      await input.onStepAppended(stepMessages);
    }

    // 水位判据（改动一）：每步结束后（工具结果已追加、下一步发起前）算 r = U / W。
    // 只作用于还会继续的 tool_use 步：撞顶即收（走兜底绝不静默），提醒则继续。
    if (result.stopReason === "tool_use") {
      const used = contextUsedTokens(result, messages);
      const window = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const ratio = used / window;
      if (ratio >= CONTEXT_STOP_RATIO) {
        watermarkStop = true;
        break;
      }
      if (ratio >= CONTEXT_WARN_RATIO && !watermarked) {
        const reminder = makeWatermarkReminder(used, window);
        messages.push(reminder);
        appended.push(reminder);
        if (input.onStepAppended) {
          await input.onStepAppended([reminder]);
        }
        watermarked = true;
      }
    }

    if (result.stopReason !== "tool_use") {
      break;
    }
  }

  // 撞顶兜底（真机实锤）：保险丝（循环耗尽）或水位撞顶且最后一次仍是工具调用——
  // 直接退出会让回合静默结束（无 assistant 回复）。追加一次无工具总结调用，绝不静默。
  if (step >= maxSteps || watermarkStop) {
    const summary = await runMaxStepsSummary(
      input,
      messages,
      maxToolResultTokens,
      emit,
      watermarkStop ? "watermark" : "max_steps",
    );
    messages.push(summary);
    appended.push(summary);
    assistantMessage = summary;
    if (input.onStepAppended) {
      await input.onStepAppended([summary]);
    }
  }

  // turn 级结束帧：与 step.end（每个 loop step 都发）区分，
  // 前端只在收到本帧时才复位"生成中"状态，避免工具执行期间输入框提前解锁
  emit({ type: "turn.end" });

  return {
    messages,
    assistantMessage: assistantMessage!,
    toolMessages,
    appended,
  };
}

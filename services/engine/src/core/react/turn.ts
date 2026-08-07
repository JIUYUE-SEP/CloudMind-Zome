import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent } from "../../provider/types.js";
import { executeLoopStep, StepStreamError, type StepInput, type StepResult } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";
import type { AssembleInput, ContextPipeline } from "../../context/pipeline.js";
import { TOOL_RESULT_BUDGET_RATIO } from "../../context/truncate.js";
import { stripUnansweredToolCalls } from "../../context/history-sanitize.js";

/** 撞顶兜底（真机实锤：连续工具调用后回合静默结束）：追加一次无工具总结的 system 提示 */
export const MAX_STEPS_SUMMARY_HINT =
  "工具调用步数已用完，请根据已获得的信息直接给出最终回复，不要再调用工具";
/** 兜底总结也失败/空文本时的最终兜底回复——回合永远要有 assistant 回复，绝不静默 */
export const MAX_STEPS_FALLBACK_REPLY = "我查了很多资料但没能整理好答案，请再问我一次";

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
   */
  appended: ChatMessage[];
}

function assistantText(message: ChatMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function makeFallbackReply(emit: (event: LLMEvent) => void): ChatMessage {
  const message: ChatMessage = {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: [{ type: "text", text: MAX_STEPS_FALLBACK_REPLY }],
    createdAt: new Date().toISOString(),
  };
  // 兜底文本不经 provider，需手动补流式帧，前端才不会空白等待
  emit({ type: "text.delta", delta: MAX_STEPS_FALLBACK_REPLY });
  return message;
}

/**
 * 撞顶兜底总结调用：maxSteps 全部消耗在工具循环（最后一次仍是 tool_use）时，
 * 在 messages 尾部追加 system 提示、tools 传空，强制模型产出最终文本。
 * 调用失败/违规工具调用/空文本 → 产出兜底回复文本（绝不静默）。
 */
async function runMaxStepsSummary(
  input: TurnInput,
  messages: ChatMessage[],
  maxToolResultTokens: number | undefined,
  emit: (event: LLMEvent) => void,
): Promise<ChatMessage> {
  const hint: ChatMessage = {
    id: `msg_${Date.now()}`,
    role: "system",
    content: [{ type: "text", text: MAX_STEPS_SUMMARY_HINT }],
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
    return makeFallbackReply(emit);
  }
  if (result.stopReason === "tool_use" || assistantText(result.assistantMessage).length === 0) {
    return makeFallbackReply(emit);
  }
  return result.assistantMessage;
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

  const maxSteps = input.maxSteps ?? 10;
  let assistantMessage: ChatMessage | undefined;
  const toolMessages: ChatMessage[] = [];
  const appended: ChatMessage[] = [];

  let step = 0;
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

    if (result.stopReason !== "tool_use") {
      break;
    }
  }

  // 撞顶兜底（真机实锤）：循环耗尽且最后一次仍是工具调用——直接退出会让
  // 回合静默结束（无 assistant 回复）。追加一次无工具总结调用，绝不静默。
  if (step >= maxSteps) {
    const summary = await runMaxStepsSummary(input, messages, maxToolResultTokens, emit);
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

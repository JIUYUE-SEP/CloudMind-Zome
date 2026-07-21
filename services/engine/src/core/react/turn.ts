import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent } from "../../provider/types.js";
import { executeLoopStep, type StepInput } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";
import type { AssembleInput, ContextPipeline } from "../../context/pipeline.js";
import { TOOL_RESULT_BUDGET_RATIO } from "../../context/truncate.js";

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
}

export interface TurnResult {
  messages: ChatMessage[];
  assistantMessage: ChatMessage;
  toolMessages: ChatMessage[];
  /** 本轮按序新增的全部消息（assistant + tool），供持久化（与输入如何组装/截断无关） */
  appended: ChatMessage[];
}

export async function runTurn(
  input: TurnInput,
  emit: (event: LLMEvent) => void
): Promise<TurnResult> {
  let messages: ChatMessage[] = [...input.messages];
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

  for (let step = 0; step < maxSteps; step++) {
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

    const result = await executeLoopStep(stepInput, emit);
    assistantMessage = result.assistantMessage;
    messages.push(result.assistantMessage);
    appended.push(result.assistantMessage);

    if (result.toolMessages) {
      messages.push(...result.toolMessages);
      toolMessages.push(...result.toolMessages);
      appended.push(...result.toolMessages);
    }

    if (result.stopReason !== "tool_use") {
      break;
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

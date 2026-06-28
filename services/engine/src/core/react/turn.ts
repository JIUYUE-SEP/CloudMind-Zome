import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent } from "../../provider/types.js";
import { executeLoopStep, type StepInput } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";

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
}

export interface TurnResult {
  messages: ChatMessage[];
  assistantMessage: ChatMessage;
  toolMessages: ChatMessage[];
}

export async function runTurn(
  input: TurnInput,
  emit: (event: LLMEvent) => void
): Promise<TurnResult> {
  const messages: ChatMessage[] = [...input.messages];
  const maxSteps = input.maxSteps ?? 10;
  let assistantMessage: ChatMessage | undefined;
  const toolMessages: ChatMessage[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const stepInput: StepInput = {
      provider: input.provider,
      model: input.model,
      messages,
      tools: input.tools,
      toolCtx: input.toolCtx,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      topP: input.topP,
    };

    const result = await executeLoopStep(stepInput, emit);
    assistantMessage = result.assistantMessage;
    messages.push(result.assistantMessage);

    if (result.toolMessages) {
      messages.push(...result.toolMessages);
      toolMessages.push(...result.toolMessages);
    }

    if (result.stopReason !== "tool_use") {
      break;
    }
  }

  return {
    messages,
    assistantMessage: assistantMessage!,
    toolMessages,
  };
}

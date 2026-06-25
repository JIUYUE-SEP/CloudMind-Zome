import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent, LLMChatParams } from "../../provider/types.js";
import { runToolCallBatch, type ToolExecutionContext, type ToolCallRequest } from "./tool-call.js";

export interface StepInput {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  toolCtx: ToolExecutionContext;
  maxTokens?: number;
}

export interface StepResult {
  stopReason: "stop" | "tool_use" | "max_tokens";
  assistantMessage: ChatMessage;
  toolMessages?: ChatMessage[];
}

export async function executeLoopStep(input: StepInput, emit: (event: LLMEvent) => void): Promise<StepResult> {
  const params: LLMChatParams = {
    model: input.model,
    messages: input.messages,
    tools: input.tools.length > 0 ? input.tools : undefined,
    maxTokens: input.maxTokens,
  };

  let textBuffer = "";
  let thinkBuffer = "";
  const toolCalls = new Map<string, ToolCallRequest>();
  let finishReason: string | undefined;

  for await (const event of input.provider.chat(params)) {
    emit(event);
    if (event.type === "step.end") {
      finishReason = event.finishReason;
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
    const toolMessages: ChatMessage[] = toolResults.map((r) => ({
      id: `tool_${r.toolCallId}`,
      role: "tool",
      content: [
        {
          type: "text",
          text: typeof r.output === "string" ? r.output : JSON.stringify(r.output),
        },
      ],
      createdAt: new Date().toISOString(),
    }));
    return { stopReason: "tool_use", assistantMessage, toolMessages };
  }

  const stopReason = finishReason === "length" ? "max_tokens" : "stop";
  return { stopReason, assistantMessage };
}

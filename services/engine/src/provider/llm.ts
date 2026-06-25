import OpenAI from "openai";
import type { LLMProvider, LLMChatParams, LLMEvent } from "./types.js";
import { ProviderError } from "./errors.js";

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  supportsModel(model: string): boolean {
    return model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3");
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    try {
      const response = await this.client.chat.completions.create({
        model: params.model,
        messages: params.messages.map((m) => {
          const base: OpenAI.ChatCompletionMessageParam = {
            role: m.role,
            content: m.content.filter((c) => c.type === "text").map((c) => c.text).join(""),
          } as OpenAI.ChatCompletionMessageParam;
          if (m.role === "assistant" && m.toolCalls) {
            return {
              ...base,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.toolCallId,
                type: "function" as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            } as OpenAI.ChatCompletionMessageParam;
          }
          return base;
        }) as unknown as OpenAI.ChatCompletionMessageParam[],
        tools: params.tools as OpenAI.ChatCompletionTool[] | undefined,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
        stream: true,
      });

      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
      let finalFinishReason: string | undefined;

      for await (const chunk of response) {
        const choice = chunk.choices[0];
        if (choice?.finish_reason) {
          finalFinishReason = choice.finish_reason;
        }

        const delta = choice?.delta as
          | (OpenAI.ChatCompletionChunk.Choice.Delta & {
              reasoning_content?: string;
              tool_calls?: ToolCallDelta[];
            })
          | undefined;

        if (delta?.content) {
          yield { type: "text.delta", delta: delta.content };
        }
        if (delta?.reasoning_content) {
          yield { type: "thinking.delta", delta: delta.reasoning_content };
        }

        const tcs = delta?.tool_calls;
        if (tcs) {
          for (const tc of tcs) {
            const index = tc.index ?? 0;
            let buf = toolCallBuffers.get(index);
            if (!buf) {
              buf = { id: tc.id || `tc_${index}`, name: "", args: "" };
              toolCallBuffers.set(index, buf);
            }
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name += tc.function.name;
            if (tc.function?.arguments) buf.args += tc.function.arguments;
          }
        }
      }

      const sortedBuffers = [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, buf] of sortedBuffers) {
        if (!buf.name) continue;
        let args: unknown = {};
        try {
          args = buf.args ? JSON.parse(buf.args) : {};
        } catch (err) {
          console.error(`Failed to parse tool call arguments for ${buf.name}: ${buf.args}`, err);
        }
        yield { type: "tool.call", toolCallId: buf.id, name: buf.name, arguments: args };
      }

      yield { type: "step.end", finishReason: finalFinishReason };
    } catch (err) {
      yield { type: "text.delta", delta: `\nProvider error: ${String(err)}` };
      yield { type: "step.end" };
      throw new ProviderError("openai", err);
    }
  }
}

export class MockLLMProvider implements LLMProvider {
  name = "mock";
  private nextToolCalls: Array<{ toolCallId: string; name: string; arguments: unknown }> = [];

  supportsModel(model: string) {
    void model;
    return true;
  }

  setNextToolCalls(toolCalls: Array<{ toolCallId: string; name: string; arguments: unknown }>): void {
    this.nextToolCalls = toolCalls;
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    if (this.nextToolCalls.length > 0) {
      for (const tc of this.nextToolCalls) {
        yield { type: "tool.call", ...tc };
      }
      this.nextToolCalls = [];
    } else {
      yield { type: "text.delta", delta: "Hello from mock" };
    }
    yield { type: "step.end" };
  }
}

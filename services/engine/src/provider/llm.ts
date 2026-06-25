import OpenAI from "openai";
import type { LLMProvider, LLMChatParams, LLMEvent } from "./types.js";

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
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: params.tools as OpenAI.ChatCompletionTool[] | undefined,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream: true,
    });

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: "text.delta", delta: delta.content };
      }
      if (delta && "reasoning_content" in delta && delta.reasoning_content) {
        yield { type: "thinking.delta", delta: delta.reasoning_content as string };
      }
      const toolCalls = delta?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        const tc = toolCalls[0];
        yield {
          type: "tool.call",
          toolCallId: tc.id || "tc_0",
          name: tc.function?.name || "",
          arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
        };
      }
    }
    yield { type: "step.end" };
  }
}

export class MockLLMProvider implements LLMProvider {
  name = "mock";
  supportsModel(model: string) {
    void model;
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    yield { type: "text.delta", delta: "Hello from mock" };
    yield { type: "step.end" };
  }
}

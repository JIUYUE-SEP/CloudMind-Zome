import { logger } from "../logger.js";
import OpenAI from "openai";
import type { LLMProvider, LLMChatParams, LLMEvent } from "./types.js";
import { ProviderError } from "./errors.js";
import { isRetryableError } from "./classify.js";

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIProviderOptions {
  /** 请求超时（ms），透传 OpenAI SDK 的 timeout；来自 ProviderConfig.requestTimeout */
  requestTimeout?: number;
}

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string, options?: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
      ...(options?.requestTimeout !== undefined ? { timeout: options.requestTimeout } : {}),
      // 禁用 SDK 内置重试：重试由 resilient 层统一接管，防双层重试叠乘
      maxRetries: 0,
    });
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
          if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            return {
              ...base,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.toolCallId,
                type: "function" as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            } as OpenAI.ChatCompletionMessageParam;
          }
          if (m.role === "tool" && m.toolCallId) {
            return {
              ...base,
              tool_call_id: m.toolCallId,
            } as OpenAI.ChatCompletionMessageParam;
          }
          return base;
        }) as unknown as OpenAI.ChatCompletionMessageParam[],
        tools: params.tools as OpenAI.ChatCompletionTool[] | undefined,
        temperature: params.temperature,
        top_p: params.topP,
        max_tokens: params.maxTokens,
        stream: true,
        // P4-5：请求流式 usage（OpenAI 协议标准参数；不支持的网关会在
        // provider 层显式报错而非静默错），落档拿不到时 tokens 记 0
        stream_options: { include_usage: true },
      });

      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
      let finalFinishReason: string | undefined;
      let usage: { promptTokens: number; completionTokens: number } | undefined;

      for await (const chunk of response) {
        // P4-5：include_usage 的末块带 usage（choices 为空）
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
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
          logger.warn({ err: err }, `Failed to parse tool call arguments for ${buf.name}: ${buf.args}`);
        }
        yield { type: "tool.call", toolCallId: buf.id, name: buf.name, arguments: args };
      }

      yield { type: "step.end", finishReason: finalFinishReason, ...(usage ? { usage } : {}) };
    } catch (err) {
      // 不再原地 yield 错误文本：错误展示职责上移给 resilient 层
      // （全链失败时统一告知），此处只抛出带分类信息的 ProviderError
      throw new ProviderError("openai", err, { retryable: isRetryableError(err) });
    }
  }
}

/**
 * Provider 配置缺失时的占位实现。
 * 不用 Mock 伪装回复，而是明确告知用户配置问题，避免"假回复"写入历史。
 */
export class ErrorLLMProvider implements LLMProvider {
  name = "error";

  constructor(private message: string) {}

  supportsModel() {
    return true;
  }

  async *chat(): AsyncIterable<LLMEvent> {
    yield { type: "text.delta", delta: this.message };
    yield { type: "step.end" };
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

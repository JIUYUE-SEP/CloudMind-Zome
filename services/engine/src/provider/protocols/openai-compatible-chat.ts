import { logger } from "../../logger.js";
import OpenAI from "openai";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../types.js";
import { ProviderError } from "../errors.js";
import { createIdleTimeout, isRetryableError, truncateLogText } from "./shared.js";

/**
 * OpenAI SDK 总时长硬兜底（ms）。
 *
 * 常规挂死由空闲超时（createIdleTimeout，缺省 180s）在更短时间内接管；这里
 * 只防「数据一直来但永不结束」的畸形长流。不设则回落 SDK 缺省 10 分钟——那
 * 会与空闲语义冲突（长回答被总时长砍断），所以显式放宽。
 */
export const SDK_HARD_TIMEOUT_MS = 30 * 60_000;

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAICompatibleChatProviderOptions {
  /** 请求超时（ms），透传 OpenAI SDK 的 timeout；来自 ProviderConfig.requestTimeout */
  requestTimeout?: number;
}

/**
 * OpenAI Chat Completions 兼容适配器（协议族兼容层）。
 *
 * 2026-08-08 协议族迁移：原 `services/engine/src/provider/llm.ts` 的
 * OpenAIProvider 整体归位到 protocols/ 并改名，行为零变化（仍走 OpenAI SDK，
 * 兼容 DeepSeek / 硅基流动等一切暴露 /chat/completions 的网关）。SDK 内置重试
 * 保持禁用，由 resilient 层统一接管。
 */
export class OpenAICompatibleChatProvider implements LLMProvider {
  name = "openai";
  /** F1：协议族标识——chat_completions 请求回传时过滤 think 块 */
  readonly protocol = "chat_completions";
  private client: OpenAI;

  constructor(
    apiKey?: string,
    baseURL?: string,
    private readonly options?: OpenAICompatibleChatProviderOptions,
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
      // 2026-11-01 P1：requestTimeout 语义由「总时长」改为「流空闲超时」
      // （与 responses/anthropic 的 postJsonStream 统一）。SDK 侧只留硬兜底，
      // 空闲判定由 chat() 里的 createIdleTimeout 负责——SDK 的 timeout 是总
      // 时长，直接沿用它会在长回答上误杀。
      timeout: SDK_HARD_TIMEOUT_MS,
      // 禁用 SDK 内置重试：重试由 resilient 层统一接管，防双层重试叠乘
      maxRetries: 0,
    });
  }

  supportsModel(model: string): boolean {
    return model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3");
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    const idle = createIdleTimeout(this.options?.requestTimeout);
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
      }, idle.signal !== undefined ? { signal: idle.signal } : {});

      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
      let finalFinishReason: string | undefined;
      let usage: { promptTokens: number; completionTokens: number } | undefined;

      for await (const chunk of response) {
        idle.reset();
        // P4-5：include_usage 的末块带 usage（choices 为空）
        // P1-3：usage 取值加 isFinite 守卫——网关缺字段/返回非有限值时保持
        // undefined，不产 NaN 污染水位计算与用量落档
        if (chunk.usage) {
          const promptTokens = chunk.usage.prompt_tokens;
          const completionTokens = chunk.usage.completion_tokens;
          if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) {
            usage = { promptTokens, completionTokens };
          } else {
            usage = undefined;
          }
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
          // A2/F3 隐私收敛：raw 走 truncateLogText 截 500（与 responses/anthropic 同口径），
          // 超长/敏感工具参数不再整段进日志
          logger.warn(
            { err: err, toolName: buf.name, raw: truncateLogText(buf.args) },
            `Failed to parse tool call arguments for ${buf.name}`,
          );
        }
        yield { type: "tool.call", toolCallId: buf.id, name: buf.name, arguments: args };
      }

      yield { type: "step.end", finishReason: finalFinishReason, ...(usage ? { usage } : {}) };
    } catch (err) {
      // 不再原地 yield 错误文本：错误展示职责上移给 resilient 层
      // （全链失败时统一告知），此处只抛出带分类信息的 ProviderError
      // 空闲超时映射为 StreamIdleTimeoutError 并强制不可重试——流可能已产出
      // 部分内容，重试会造成重复输出
      const mapped = idle.mapError(err);
      throw new ProviderError("openai", mapped, {
        retryable: idle.timedOut ? false : isRetryableError(mapped),
      });
    } finally {
      idle.dispose();
    }
  }
}

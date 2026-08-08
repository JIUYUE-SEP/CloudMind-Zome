import type { LLMProvider, LLMChatParams, LLMEvent } from "../types.js";
import { ProviderError } from "../errors.js";
import { postJsonStream, trimBaseUrl, parseToolArgs, isRecord } from "./shared.js";

/**
 * OpenAI Responses API 适配器（协议族主路新推荐）。
 *
 * 结构仿 opencode packages/llm/src/protocols/openai-responses.ts：请求体下降
 * （messages→input items / 工具定义转 function items）+ 流式事件状态机
 * （output_text.delta / reasoning_text.delta / function_call_arguments.delta /
 * output_item.done）+ usage 落账（response.completed 的 usage 字段）。
 * 实现按 CMZ 基建重写：无 effect/Schema，直接 fetch + 手写 SSE 解析，
 * 产出 CMZ 的 LLMEvent（text.delta / thinking.delta / tool.call / step.end）。
 *
 * 已按 DeepSeek 官方 Responses API 文档（api-docs.deepseek.com/guides/responses_api）
 * 交叉核对：base_url 根域 + POST /responses；input items 支持 message
 * （user/assistant/system/developer）、function_call、function_call_output、
 * reasoning（plain-text content，summary/encrypted_content 不支持）；
 * 流式无 [DONE]，终态为 response.completed / response.incomplete /
 * response.failed；usage 在终态 response.usage 携带。
 */
export interface OpenAIResponsesProviderOptions {
  /** 请求超时（ms），来自 ProviderConfig.requestTimeout */
  requestTimeout?: number;
}

interface FunctionCallItem {
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface ResponsesEvent {
  type: string;
  item_id?: string;
  delta?: string;
  item?: Record<string, unknown>;
  response?: {
    status?: string;
    usage?: ResponsesUsage | null;
    error?: { code?: string | null; message?: string | null } | null;
  };
  code?: string | null;
  message?: string | null;
}

/** DeepSeek 要求 reasoning item 用纯文本 content（OpenAI 的 summary 不支持） */
interface ReasoningInputItem {
  type: "reasoning";
  content: string;
}

type InputItem = Record<string, unknown> | ReasoningInputItem;

/** 聊天消息 → Responses input items（opencode lowerMessages 的 CMZ 版） */
function lowerMessages(params: LLMChatParams): InputItem[] {
  const input: InputItem[] = [];

  // 开头连续 system 消息合并为一个 system item（等价 instructions 语义）
  let index = 0;
  const systemText: string[] = [];
  while (index < params.messages.length && params.messages[index].role === "system") {
    const text = params.messages[index].content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) systemText.push(text);
    index++;
  }
  if (systemText.length > 0) {
    input.push({ role: "system", content: systemText.join("\n") });
  }

  for (; index < params.messages.length; index++) {
    const message = params.messages[index];
    if (message.role === "system") {
      // 中段 system 更新：Responses 不保证任意位置 system item 语义，
      // 按 opencode 同款降级为可见 user 文本（保持时间位置）
      const text = message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const wrapped = `<system-update>\n${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</system-update>`;
      const previous = input.at(-1);
      if (isRecord(previous) && previous.role === "user" && Array.isArray(previous.content)) {
        previous.content.push({ type: "input_text", text: wrapped });
      } else {
        input.push({ role: "user", content: [{ type: "input_text", text: wrapped }] });
      }
      continue;
    }

    if (message.role === "user") {
      input.push({
        role: "user",
        content: message.content.map((c) => ({
          type: "input_text",
          text: c.type === "text" ? c.text : c.think,
        })),
      });
      continue;
    }

    if (message.role === "assistant") {
      // 文本 → output_text；think → reasoning item（DeepSeek 原生支持，plain-text content）
      const text = message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const c of message.content) {
        if (c.type === "think" && c.think) input.push({ type: "reasoning", content: c.think });
      }
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.toolCallId,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
      }
      continue;
    }

    // tool 消息
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (message.toolCallId) {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: text });
    }
  }

  return input;
}

function lowerTools(tools: unknown[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    const t = isRecord(tool) ? tool : {};
    const fn = isRecord(t.function) ? t.function : t;
    return {
      type: "function",
      name: typeof fn.name === "string" ? fn.name : "",
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    };
  });
}

/**
 * Responses 流式事件状态机。逐事件产出 CMZ LLMEvent：
 * - output_text.delta → text.delta
 * - reasoning_text.delta → thinking.delta
 * - function_call_arguments.delta → 累加参数
 * - output_item.added/done(function_call) → tool.call（done 携带的完整 arguments 优先）
 * - response.completed/incomplete → step.end（usage 落账）
 * - response.failed / error → ProviderError
 */
export class OpenAIResponsesProvider implements LLMProvider {
  name = "openai-responses";

  constructor(
    private apiKey: string | undefined,
    private baseUrl: string,
    private options: OpenAIResponsesProviderOptions = {},
  ) {}

  supportsModel(model: string): boolean {
    return model.startsWith("deepseek-v4-") || model.startsWith("gpt-");
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    const url = `${trimBaseUrl(this.baseUrl)}/responses`;
    const body: Record<string, unknown> = {
      model: params.model,
      input: lowerMessages(params),
      stream: true,
    };
    if (params.maxTokens !== undefined) body.max_output_tokens = params.maxTokens;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.tools && params.tools.length > 0) body.tools = lowerTools(params.tools);

    try {
      const { data } = await postJsonStream(this.name, url, body, {
        apiKey: this.apiKey,
        requestTimeout: this.options.requestTimeout,
      });

      // item_id → 进行中的 function_call 累加器（opencode ToolStream 的 CMZ 版）
      const toolBuffers = new Map<string, FunctionCallItem>();
      let usage: { promptTokens: number; completionTokens: number } | undefined;

      for await (const raw of data) {
        let event: ResponsesEvent;
        try {
          event = JSON.parse(raw) as ResponsesEvent;
        } catch {
          throw new ProviderError(this.name, `无效的 SSE JSON 帧: ${raw}`, {
            retryable: false,
          });
        }

        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta) yield { type: "text.delta", delta: event.delta };
            break;

          case "response.reasoning_text.delta":
            if (event.delta) yield { type: "thinking.delta", delta: event.delta };
            break;

          case "response.output_item.added": {
            const item = event.item;
            if (item?.type === "function_call" && typeof item.id === "string") {
              toolBuffers.set(item.id, {
                id: item.id,
                call_id: typeof item.call_id === "string" ? item.call_id : item.id,
                name: typeof item.name === "string" ? item.name : "",
              });
            }
            break;
          }

          case "response.function_call_arguments.delta": {
            if (!event.item_id || !event.delta) break;
            const buf = toolBuffers.get(event.item_id);
            if (buf) buf.arguments = `${buf.arguments ?? ""}${event.delta}`;
            break;
          }

          case "response.output_item.done": {
            const item = event.item;
            if (item?.type === "function_call" && typeof item.id === "string") {
              const buf = toolBuffers.get(item.id);
              if (buf) {
                const finalArgs =
                  typeof item.arguments === "string" ? item.arguments : (buf.arguments ?? "");
                const name = typeof item.name === "string" && item.name ? item.name : buf.name;
                if (name) {
                  yield {
                    type: "tool.call",
                    toolCallId: typeof item.call_id === "string" ? item.call_id : buf.call_id ?? item.id,
                    name,
                    arguments: parseToolArgs(name, finalArgs),
                  };
                }
                toolBuffers.delete(item.id);
              }
            }
            break;
          }

          case "response.completed":
          case "response.incomplete": {
            const u = event.response?.usage;
            if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
              usage = { promptTokens: u.input_tokens, completionTokens: u.output_tokens };
            }
            yield {
              type: "step.end",
              ...(event.type === "response.incomplete" ? { finishReason: "length" } : {}),
              ...(usage ? { usage } : {}),
            };
            return;
          }

          case "response.failed": {
            const err = event.response?.error;
            const message =
              err?.message || event.message || "OpenAI Responses response failed";
            throw new ProviderError(this.name, message, { retryable: false });
          }

          case "error": {
            const message = event.message || event.code || "OpenAI Responses stream error";
            throw new ProviderError(this.name, message, { retryable: false });
          }

          default:
            // response.created / in_progress / content_part.* / reasoning_text.done /
            // output_text.done / function_call_arguments.done / web_search_call.*：忽略
            break;
        }
      }

      // 流被服务端提前掐断且无终态事件：协议违约，不可重试（可能已有部分输出）
      throw new ProviderError(this.name, "SSE 流提前结束，缺少终态事件");
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(this.name, err);
    }
  }
}

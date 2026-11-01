import type { LLMProvider, LLMChatParams, LLMEvent } from "../types.js";
import { ProviderError } from "../errors.js";
import {
  anthropicMessagesUrl,
  ANTHROPIC_VERSION,
  postJsonStream,
  parseToolArgs,
  isRecord,
  toProviderError,
  truncateLogText,
} from "./shared.js";

/**
 * Anthropic Messages 适配器（协议族主路）。
 *
 * 结构仿 opencode packages/llm/src/protocols/anthropic-messages.ts：system 独立
 * 字段、content blocks（text/thinking/tool_use/tool_result）、SSE 事件状态机
 * （message_start / content_block_start|delta|stop / message_delta /
 * message_stop）、usage 落账。实现按 CMZ 基建重写：fetch + 手写 SSE。
 *
 * 已按 DeepSeek 官方 Anthropic API 文档（api-docs.deepseek.com/guides/anthropic_api）
 * 交叉核对：base_url https://api.deepseek.com/anthropic + POST /v1/messages；
 * x-api-key 鉴权（anthropic-version 忽略但仍发送，兼容原生 Anthropic）；
 * content 支持 text / thinking / tool_use / tool_result（is_error 忽略）；
 * 服务端 tool（server_tool_use / web_search_tool_result）不属于本版调用路径，
 * 与 opencode 的 client-tool 语义一致：只处理本地函数工具往返。
 */
export interface AnthropicMessagesProviderOptions {
  /** 请求超时（ms），来自 ProviderConfig.requestTimeout */
  requestTimeout?: number;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

/** 聊天消息 → Anthropic messages（blocks 数组），system 走独立字段 */
function lowerMessages(params: LLMChatParams): Array<{
  role: "user" | "assistant";
  content: Record<string, unknown>[];
}> {
  const messages: Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }> = [];

  // 开头连续 system 已进 body.system，这里跳过，避免双写
  let index = 0;
  while (index < params.messages.length && params.messages[index].role === "system") index++;

  for (; index < params.messages.length; index++) {
    const message = params.messages[index];
    if (message.role === "system") {
      // 中段 system 更新：Anthropic 无中段 system 角色，按 opencode 同款
      // 降级为可见 user 文本（紧跟相邻 user 消息或新开一条）
      const text = message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const wrapped = `<system-update>\n${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</system-update>`;
      const previous = messages.at(-1);
      if (previous?.role === "user") previous.content.push({ type: "text", text: wrapped });
      else messages.push({ role: "user", content: [{ type: "text", text: wrapped }] });
      continue;
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content.map((c) => ({
          type: "text",
          text: c.type === "text" ? c.text : c.think,
        })),
      });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      for (const c of message.content) {
        if (c.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
        if (c.type === "think" && c.think) {
          // DeepSeek Anthropic 端点支持 thinking block（signature 可缺省）
          blocks.push({ type: "thinking", thinking: c.think });
        }
      }
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.toolCallId,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    // tool 消息 → tool_result 块
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (message.toolCallId) {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: text }],
      });
    }
  }

  return messages;
}

function lowerSystem(params: LLMChatParams): Array<{ type: "text"; text: string }> {
  const system: string[] = [];
  for (const message of params.messages) {
    if (message.role !== "system") break; // 只取开头连续 system
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) system.push(text);
  }
  return system.map((text) => ({ type: "text", text }));
}

function lowerTools(tools: unknown[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    const t = isRecord(tool) ? tool : {};
    const fn = isRecord(t.function) ? t.function : t;
    return {
      name: typeof fn.name === "string" ? fn.name : "",
      description: typeof fn.description === "string" ? fn.description : "",
      input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    };
  });
}

function mapFinishReason(reason: string | null | undefined): string | undefined {
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  return undefined;
}

/**
 * Anthropic SSE 事件状态机 → CMZ LLMEvent：
 * - content_block_delta.text_delta → text.delta
 * - content_block_delta.thinking_delta → thinking.delta
 * - content_block_start/input_json_delta/stop(tool_use) → tool.call 累加与产出
 * - message_start/message_delta 的 usage 右偏合并（最终 message_delta 为权威）
 * - message_stop → step.end（finishReason 映射 + usage 落账）
 * - error → ProviderError
 */
export class AnthropicMessagesProvider implements LLMProvider {
  name = "anthropic-messages";
  /** F1：协议族标识——anthropic 会把 think 作为 thinking 块真回传（占窗口） */
  readonly protocol = "anthropic";

  constructor(
    private apiKey: string | undefined,
    private baseUrl: string,
    private options: AnthropicMessagesProviderOptions = {},
  ) {}

  supportsModel(): boolean {
    // DeepSeek 会把 claude-* 型号名映射到自家模型；任何模型名都放行
    return true;
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096, // Anthropic 必填
      stream: true,
    };
    const system = lowerSystem(params);
    if (system.length > 0) body.system = system;
    const messages = lowerMessages(params);
    if (messages.length > 0) body.messages = messages;
    if (params.tools && params.tools.length > 0) body.tools = lowerTools(params.tools);
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== undefined) body.top_p = params.topP;

    try {
      const { data } = await postJsonStream(this.name, anthropicMessagesUrl(this.baseUrl), body, {
        apiKey: this.apiKey,
        apiKeyHeader: "x-api-key",
        headers: { "anthropic-version": ANTHROPIC_VERSION },
        requestTimeout: this.options.requestTimeout,
        // 2026-11-01 P2：外部取消信号贯通到 fetch，中断不再等当前步自然结束
        signal: params.signal,
      });

      // index → 进行中的 tool_use 累加器（opencode ToolStream<number> 的 CMZ 版）
      const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
      let usage: { promptTokens: number; completionTokens: number } | undefined;
      let finishReason: string | undefined;
      let stepEnded = false;
      /** 是否已产出任何可见内容（文本/思考/工具调用）——空流判死用（P1-2） */
      let emittedContent = false;

      for await (const raw of data) {
        let event: AnthropicEvent;
        try {
          event = JSON.parse(raw) as AnthropicEvent;
        } catch {
          throw new ProviderError(
            this.name,
            `无效的 SSE JSON 帧: ${truncateLogText(raw)}`,
            { retryable: false },
          );
        }

        switch (event.type) {
          case "message_start": {
            const u = event.message?.usage;
            if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
              usage = { promptTokens: u.input_tokens, completionTokens: u.output_tokens };
            }
            break;
          }

          case "content_block_start": {
            const block = event.content_block;
            if (block?.type === "tool_use" && event.index !== undefined && block.id && block.name) {
              toolBuffers.set(event.index, { id: block.id, name: block.name, args: "" });
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta?.type === "text_delta" && delta.text) {
              emittedContent = true;
              yield { type: "text.delta", delta: delta.text };
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              emittedContent = true;
              yield { type: "thinking.delta", delta: delta.thinking };
            } else if (delta?.type === "input_json_delta" && event.index !== undefined && delta.partial_json) {
              const buf = toolBuffers.get(event.index);
              if (buf) buf.args += delta.partial_json;
            }
            // signature_delta：CMZ 不消费 Anthropic 续聊签名，忽略
            break;
          }

          case "content_block_stop": {
            if (event.index === undefined) break;
            const buf = toolBuffers.get(event.index);
            // 取舍：stop 事件本体只携带 index（无 id/name/input），无法像
            // openai-responses 的 output_item.done 那样用事件本体兜底组装——
            // 缺 content_block_start 的孤立 stop 属协议违约（DeepSeek/原生
            // Anthropic 均先 start 后 stop），只能丢弃，不虚构 tool.call
            if (buf) {
              emittedContent = true;
              yield {
                type: "tool.call",
                toolCallId: buf.id,
                name: buf.name,
                arguments: parseToolArgs(buf.name, buf.args),
              };
              toolBuffers.delete(event.index);
            }
            break;
          }

          case "message_delta": {
            if (event.delta?.stop_reason) finishReason = mapFinishReason(event.delta.stop_reason);
            const u = event.usage;
            // F8：双端点形态差异——DeepSeek 端点 message_delta 带 input+output 双
            // 字段，原生 Anthropic 端点只带 output_tokens（input 已在 message_start
            // 给出）。守卫放宽为 output_tokens 单 number 即更新，合并语义：output
            // 覆盖、input 保留 message_start 值；否则原生端点 completionTokens 会
            // 停在 message_start 初值（≈1）失真。input 无来源（message_start 也缺）
            // 时不虚构 promptTokens，usage 整体不落账
            if (u && typeof u.output_tokens === "number") {
              const prompt = typeof u.input_tokens === "number" ? u.input_tokens : usage?.promptTokens;
              if (prompt !== undefined) {
                usage = { promptTokens: prompt, completionTokens: u.output_tokens };
              }
            }
            break;
          }

          case "message_stop": {
            stepEnded = true;
            yield {
              type: "step.end",
              ...(finishReason ? { finishReason } : {}),
              ...(usage ? { usage } : {}),
            };
            return;
          }

          case "error": {
            const message = event.error?.message || event.error?.type || "Anthropic Messages stream error";
            throw new ProviderError(this.name, message, { retryable: false });
          }

          default:
            // ping / 未知事件：忽略
            break;
        }
      }

      // 流结束但未收到 message_stop（网关截断，P1-2）。三族空流/截断口径
      // 各不相同（既定取舍，不对齐行为，仅如实记录）：
      // - 本族（anthropic）：空流判死抛「可重试」错误（首事件前失败，
      //   resilient 可重试/降级，不留空 assistant 落盘）；非空半截容错收尾
      //   step.end（内容已上屏，不丢）；
      // - openai-responses：无论是否已有产出，缺终态事件一律抛「不可重试」
      //   错误（response.completed/incomplete 为唯一权威收尾，半截不重试
      //   防重复上屏）——retryable 分类与本族相反；
      // - chat_completions：无终态事件概念，流干净结束即收尾，不判死。
      if (!stepEnded) {
        if (!emittedContent) {
          throw new ProviderError(
            this.name,
            "Anthropic SSE 流提前结束且无任何内容（空流）",
            { retryable: true },
          );
        }
        yield {
          type: "step.end",
          ...(finishReason ? { finishReason } : {}),
          ...(usage ? { usage } : {}),
        };
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw toProviderError(this.name, err);
    }
  }
}

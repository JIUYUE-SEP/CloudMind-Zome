import { logger } from "../../logger.js";
import type { LLMProvider } from "../types.js";
import { OpenAICompatibleChatProvider } from "./openai-compatible-chat.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import { AnthropicMessagesProvider } from "./anthropic-messages.js";

/** ProviderConfig.apiMode 允许值（缺省 chat_completions，现有配置零破坏） */
export const API_MODES = ["responses", "anthropic", "chat_completions"] as const;
export type ApiMode = (typeof API_MODES)[number];

export function isApiMode(value: unknown): value is ApiMode {
  return typeof value === "string" && (API_MODES as readonly string[]).includes(value);
}

export interface ProtocolProviderOptions {
  apiKey?: string;
  baseUrl: string;
  requestTimeout?: number;
}

/**
 * 按 apiMode 实例化协议适配器（2026-08-08 协议族迁移）：
 * - responses（主路新推荐）：POST {baseURL}/responses
 * - anthropic（主路）：POST {baseURL}/anthropic/v1/messages
 * - chat_completions（兼容层）：现有 OpenAI Chat Completions 逻辑
 *
 * 缺省与非法值一律落 chat_completions（配置零破坏 + 脏数据容错），
 * 非法值记 warn 便于排障。
 */
export function createProtocolProvider(
  apiMode: string | undefined,
  options: ProtocolProviderOptions,
): LLMProvider {
  const mode = apiMode ?? "chat_completions";
  if (!isApiMode(mode)) {
    logger.warn(
      `[provider] 未知 apiMode「${mode}」，按 chat_completions 处理（ProviderConfig 只允许 responses/anthropic/chat_completions）`,
    );
    return new OpenAICompatibleChatProvider(options.apiKey, options.baseUrl, {
      requestTimeout: options.requestTimeout,
    });
  }
  switch (mode) {
    case "responses":
      return new OpenAIResponsesProvider(options.apiKey, options.baseUrl, {
        requestTimeout: options.requestTimeout,
      });
    case "anthropic":
      return new AnthropicMessagesProvider(options.apiKey, options.baseUrl, {
        requestTimeout: options.requestTimeout,
      });
    case "chat_completions":
    default:
      return new OpenAICompatibleChatProvider(options.apiKey, options.baseUrl, {
        requestTimeout: options.requestTimeout,
      });
  }
}

export {
  OpenAICompatibleChatProvider,
} from "./openai-compatible-chat.js";
export { OpenAIResponsesProvider } from "./openai-responses.js";
export { AnthropicMessagesProvider } from "./anthropic-messages.js";

export type { OpenAICompatibleChatProviderOptions } from "./openai-compatible-chat.js";
export type { OpenAIResponsesProviderOptions } from "./openai-responses.js";
export type { AnthropicMessagesProviderOptions } from "./anthropic-messages.js";

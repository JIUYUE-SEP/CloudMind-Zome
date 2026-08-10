import { logger } from "../../logger.js";
import type { LLMProvider, LLMChatParams, LLMEvent, LLMProviderProtocol } from "../types.js";
import type { ProviderConfig } from "@mindcloud/shared";
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

/**
 * 型号级 apiMode 覆盖路由（2026-08-10 B 方案）：
 * 同一 provider 下不同 apiMode 的型号走不同协议适配器——按
 * (providerId, effectiveApiMode) 建/缓存适配器实例；chat 时按当前型号的
 * 生效 apiMode 选适配器（型号无覆盖 → provider 级 apiMode → chat_completions）。
 * protocol 预检口径固定为主型号（defaultModel）的生效协议——turn.ts 在
 * chat 前读 protocol 且始终以 worker 主型号发起，per-model 覆盖后不再
 * 回落到 provider 级默认值。
 */
export interface ModelApiModeRouterOptions {
  /** ProviderConfig.id（缓存键第一分量） */
  providerId: string;
  /** 型号表 + provider 级缺省（apiMode/models/apiKey/baseUrl/requestTimeout） */
  provider: Pick<
    ProviderConfig,
    "apiMode" | "models" | "apiKey" | "baseUrl" | "requestTimeout"
  >;
  /** 协议预检口径的主型号（worker 主模型；缺省 provider.models[0]?.id） */
  defaultModel?: string;
  /** 测试注入：按 (providerId, effectiveApiMode) 建适配器；缺省 createProtocolProvider */
  createAdapter?: (
    providerId: string,
    apiMode: string | undefined,
    options: ProtocolProviderOptions,
  ) => LLMProvider;
}

/** 适配器缓存键分隔符（与 W 查找链同款 \u0000，防 id 拼接歧义） */
const ADAPTER_KEY_SEPARATOR = "\u0000";

export class ModelApiModeRouter implements LLMProvider {
  name: string;
  private readonly adapters = new Map<string, LLMProvider>();
  /** 预检/落档口径：主型号生效协议（per-model 覆盖优先，无覆盖落 provider 级） */
  private readonly defaultProtocol: LLMProviderProtocol | undefined;

  constructor(private readonly options: ModelApiModeRouterOptions) {
    this.name = `model-router:${options.providerId}`;
    this.defaultProtocol = this.protocolFor(
      options.defaultModel ?? options.provider.models[0]?.id ?? "",
    );
  }

  /** 型号无覆盖 → provider 级 apiMode；再缺省 chat_completions（与 createProtocolProvider 同归） */
  private effectiveApiMode(model: string): string {
    const override = this.options.provider.models.find((m) => m.id === model)?.apiMode;
    return override ?? this.options.provider.apiMode ?? "chat_completions";
  }

  private protocolFor(model: string): LLMProviderProtocol | undefined {
    const mode = this.effectiveApiMode(model);
    return isApiMode(mode) ? mode : "chat_completions";
  }

  get protocol(): LLMProviderProtocol | undefined {
    return this.defaultProtocol;
  }

  private adapterOptions(): ProtocolProviderOptions {
    return {
      apiKey: this.options.provider.apiKey,
      baseUrl: this.options.provider.baseUrl,
      requestTimeout: this.options.provider.requestTimeout,
    };
  }

  /** 按 (providerId, effectiveApiMode) 建/缓存协议适配器（同一生效模式共享单实例） */
  private adapterFor(model: string): LLMProvider {
    const mode = this.effectiveApiMode(model);
    const key = `${this.options.providerId}${ADAPTER_KEY_SEPARATOR}${mode}`;
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = this.options.createAdapter
        ? this.options.createAdapter(this.options.providerId, mode, this.adapterOptions())
        : createProtocolProvider(mode, this.adapterOptions());
      this.adapters.set(key, adapter);
    }
    return adapter;
  }

  supportsModel(model: string): boolean {
    return this.adapterFor(model).supportsModel(model);
  }

  chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    return this.adapterFor(params.model).chat(params);
  }
}

/** 型号表是否存在 apiMode 覆盖（存在才用路由；无覆盖保持既有 per-provider 单实例路径） */
export function hasModelApiModeOverride(
  provider: Pick<ProviderConfig, "models">,
): boolean {
  return provider.models.some((m) => m.apiMode !== undefined);
}

export {
  OpenAICompatibleChatProvider,
} from "./openai-compatible-chat.js";
export { OpenAIResponsesProvider } from "./openai-responses.js";
export { AnthropicMessagesProvider } from "./anthropic-messages.js";

export type { OpenAICompatibleChatProviderOptions } from "./openai-compatible-chat.js";
export type { OpenAIResponsesProviderOptions } from "./openai-responses.js";
export type { AnthropicMessagesProviderOptions } from "./anthropic-messages.js";

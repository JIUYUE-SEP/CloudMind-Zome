import { logger } from "../../logger.js";
import type { LLMProvider, LLMChatParams, LLMEvent, LLMProviderProtocol } from "../types.js";
import type { ModelInfo, ProtocolApiMode, ProviderConfig } from "@mindcloud/shared";
import { OpenAICompatibleChatProvider } from "./openai-compatible-chat.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import { AnthropicMessagesProvider } from "./anthropic-messages.js";

/** ProviderConfig.apiMode 允许值（缺省 chat_completions，现有配置零破坏） */
const API_MODES: readonly ProtocolApiMode[] = ["responses", "anthropic", "chat_completions"];
export type ApiMode = ProtocolApiMode;

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
 *
 * R1（型号表热更新，2026-08-10 修复）：生产路径注入 resolveProvider 从活配置
 * 解析——每次 chat/refresh 都按 config.json 当前内容重算生效 apiMode 与协议
 * 口径（stamp 短缓存避免逐 step 整文件读+解密），型号表 PUT 后下一次调用
 * 即走新协议，无需重建 Router/重启；适配器缓存同键但 provider 级选项
 * （baseUrl/apiKey/requestTimeout）变化时自动重建。
 *
 * R2（不变量）：protocol() 是单值口径（defaultModel 的生效协议），而 chat()
 * 逐型号路由——调用方必须保证 runTurn 始终以 defaultModel 发起；turn.ts 在
 * 传入型号 ≠ defaultModel 时 warn 一次（不 crash）。压缩/话题裁判等直连
 * provider.chat 的路径不走水位预检，不受本不变量约束。
 */
export interface ModelApiModeRouterOptions {
  /** ProviderConfig.id（缓存键第一分量） */
  providerId: string;
  /**
   * 型号表 + provider 级缺省（apiMode/models/apiKey/baseUrl/requestTimeout）。
   * 创建时快照：supportsModel 与无 resolveProvider 场景兜底用；R1 活配置
   * 解析存在时以活配置为准。
   */
  provider: Pick<
    ProviderConfig,
    "apiMode" | "models" | "apiKey" | "baseUrl" | "requestTimeout"
  >;
  /**
   * R1：活配置解析（生产路径由 bootstrap 注入 ConfigRepository.load +
   * providers.find）。每次 chat/refresh 按需取最新 ProviderConfig；返回
   * undefined（provider 已删除）时回落创建时快照。
   */
  resolveProvider?: () => Promise<
    Pick<ProviderConfig, "apiMode" | "models" | "apiKey" | "baseUrl" | "requestTimeout"> | undefined
  >;
  /**
   * S7/F3 同款短缓存失效依据（config.json mtime+size）：提供时配置未变直接
   * 复用上次解析结果，配置变更后下一次调用即感知；缺省每次调用都重新解析。
   */
  getConfigFileStamp?: () => Promise<{ mtimeMs: number; size: number } | undefined>;
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

type LiveProvider = Pick<
  ProviderConfig,
  "apiMode" | "models" | "apiKey" | "baseUrl" | "requestTimeout"
>;

interface CachedAdapter {
  adapter: LLMProvider;
  options: ProtocolProviderOptions;
}

/** R1 容错：活配置解析失败只 warn 一次（providerId 维度），避免逐 step 刷屏 */
const liveProviderWarned = new Set<string>();

function sameProtocolOptions(a: ProtocolProviderOptions, b: ProtocolProviderOptions): boolean {
  return a.baseUrl === b.baseUrl && a.requestTimeout === b.requestTimeout && a.apiKey === b.apiKey;
}

export class ModelApiModeRouter implements LLMProvider {
  name: string;
  /** R2 不变量：runTurn 必须以该主型号发起（protocol() 单值口径的绑定假设） */
  readonly defaultModel: string;
  private readonly adapters = new Map<string, CachedAdapter>();
  /** 预检/落档口径：主型号生效协议（R1 起每次 refresh/chat 从活配置重算，不再冻结） */
  private currentProtocol: LLMProviderProtocol | undefined;
  /** R1 活配置短缓存（stamp 未变直接复用，避免逐 step 整文件读+解密） */
  private liveProviderCache?: { stamp: { mtimeMs: number; size: number }; provider: LiveProvider };

  constructor(private readonly options: ModelApiModeRouterOptions) {
    this.name = `model-router:${options.providerId}`;
    this.defaultModel = options.defaultModel ?? options.provider.models[0]?.id ?? "";
    this.currentProtocol = this.protocolFor(this.defaultModel, options.provider);
  }

  /** R1：从活配置刷新主型号协议口径（runTurn 预检前调用；失败回落快照不 crash） */
  async refresh(): Promise<void> {
    const provider = await this.liveProvider();
    this.currentProtocol = this.protocolFor(this.defaultModel, provider);
  }

  /** 型号无覆盖 → provider 级 apiMode；再缺省 chat_completions（与 createProtocolProvider 同归） */
  private effectiveApiMode(provider: LiveProvider, model: string): string {
    // R3 同款守卫（对照 hasModelApiModeOverride）：手写/旧版 config.json 的活配置
    // 可能缺 models 字段，?? [] 避免 .find TypeError
    const override = (provider.models ?? []).find((m) => m.id === model)?.apiMode;
    return override ?? provider.apiMode ?? "chat_completions";
  }

  private protocolFor(model: string, provider: LiveProvider): LLMProviderProtocol | undefined {
    const mode = this.effectiveApiMode(provider, model);
    return isApiMode(mode) ? mode : "chat_completions";
  }

  get protocol(): LLMProviderProtocol | undefined {
    return this.currentProtocol;
  }

  /** R1：取活配置（stamp 未变复用缓存；resolveProvider 缺省回落创建时快照） */
  private async liveProvider(): Promise<LiveProvider> {
    if (!this.options.resolveProvider) return this.options.provider;
    const stamp = await this.options.getConfigFileStamp?.();
    if (stamp !== undefined) {
      const cached = this.liveProviderCache;
      if (
        cached !== undefined &&
        cached.stamp.mtimeMs === stamp.mtimeMs &&
        cached.stamp.size === stamp.size
      ) {
        return cached.provider;
      }
    }
    let provider: LiveProvider | undefined;
    try {
      provider = await this.options.resolveProvider();
    } catch (err) {
      // R1 防御：配置读取失败不阻断对话——回落上次缓存/创建时快照（同 W 链口径），
      // 配置修复后下一次调用自动恢复
      if (!liveProviderWarned.has(this.options.providerId)) {
        liveProviderWarned.add(this.options.providerId);
        logger.warn(
          { err: err, providerId: this.options.providerId },
          "[model-router] 活配置解析失败，回落缓存/创建时快照",
        );
      }
      return this.liveProviderCache?.provider ?? this.options.provider;
    }
    if (provider !== undefined && stamp !== undefined) {
      this.liveProviderCache = { stamp, provider };
    }
    return provider ?? this.options.provider;
  }

  /** 按 (providerId, effectiveApiMode) 建/缓存协议适配器（同一生效模式共享单实例） */
  private adapterFor(model: string, provider: LiveProvider): LLMProvider {
    const mode = this.effectiveApiMode(provider, model);
    const options: ProtocolProviderOptions = {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      requestTimeout: provider.requestTimeout,
    };
    const key = `${this.options.providerId}${ADAPTER_KEY_SEPARATOR}${mode}`;
    let entry = this.adapters.get(key);
    // R1：同生效模式但 provider 级选项（baseUrl/apiKey/requestTimeout）变化时重建，
    // 避免活配置解析后仍复用旧选项适配器
    if (entry === undefined || !sameProtocolOptions(entry.options, options)) {
      const adapter = this.options.createAdapter
        ? this.options.createAdapter(this.options.providerId, mode, options)
        : createProtocolProvider(mode, options);
      entry = { adapter, options };
      this.adapters.set(key, entry);
    }
    return entry.adapter;
  }

  supportsModel(model: string): boolean {
    return this.adapterFor(model, this.options.provider).supportsModel(model);
  }

  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    const provider = await this.liveProvider();
    // R1：每次调用以活配置重算主型号预检口径——即使调用方未先 refresh，
    // 本次 chat 后 protocol() 也已自愈（下一轮预检即新口径）
    this.currentProtocol = this.protocolFor(this.defaultModel, provider);
    yield* this.adapterFor(params.model, provider).chat(params);
  }
}

/** 型号表是否存在 apiMode 覆盖（存在才用路由；无覆盖保持既有 per-provider 单实例路径） */
export function hasModelApiModeOverride(
  provider: { models?: ModelInfo[] },
): boolean {
  // R3：手写/旧版 config.json 可能缺 models 字段，按无覆盖处理（改动前不读 models）
  return (provider.models ?? []).some((m) => m.apiMode !== undefined);
}

export {
  OpenAICompatibleChatProvider,
} from "./openai-compatible-chat.js";
export { OpenAIResponsesProvider } from "./openai-responses.js";
export { AnthropicMessagesProvider } from "./anthropic-messages.js";

export type { OpenAICompatibleChatProviderOptions } from "./openai-compatible-chat.js";
export type { OpenAIResponsesProviderOptions } from "./openai-responses.js";
export type { AnthropicMessagesProviderOptions } from "./anthropic-messages.js";

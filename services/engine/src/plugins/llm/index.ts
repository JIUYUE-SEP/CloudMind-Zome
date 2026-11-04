import type { Context } from "cordis";
import { logger } from "../../logger.js";
import { MockLLMProvider, ErrorLLMProvider } from "../../provider/llm.js";
import {
  createProtocolProvider,
  hasModelApiModeOverride,
  ModelApiModeRouter,
} from "../../provider/protocols/index.js";
import type { EmbedderProvider, ImageGenProvider, LLMProvider } from "../../provider/types.js";
import { OpenAIEmbedderProvider, MockEmbedderProvider } from "../../provider/embedder.js";
import { OpenAIImageGenProvider, MockImageGenProvider } from "../../provider/image-gen.js";
import type { AgentConfig, ProviderConfig } from "@cloudmind/shared";

/**
 * llm 插件（P2）：provider 工厂面上架 ctx.llm。
 *
 * 上架的是**工厂能力**而非实例——per-agent provider 实例仍由消费方
 * （worker 创建链 / puppet runtime / plan / reconcile）按需现造，
 * `resilient(record(provider))` 的 call-site 包装语义不变（record-calls.ts
 * 同目录，仍是函数导出）。provider/ 物理位置不动，本文件作挂载面 import 它；
 * protocols 三适配器内部行为一行未改（含 NODE_ENV==='e2e' 的 Mock 分支）。
 */

/** ctx.llm 上架面：按 agentConfig 现造实例的工厂群（原 bootstrap.ts 工厂群本体） */
export interface LlmFactories {
  findProviderConfig(providerId: string | undefined): Promise<ProviderConfig | undefined>;
  createProvider(agentConfig: AgentConfig): Promise<LLMProvider>;
  createFallback(
    providerId: string,
    agentConfig: AgentConfig,
  ): Promise<{ provider: LLMProvider; config?: ProviderConfig } | undefined>;
  createEmbedder(agentConfig: AgentConfig): Promise<EmbedderProvider>;
  createImage(agentConfig: AgentConfig): Promise<ImageGenProvider | undefined>;
}

export const name = "llm";

/** 工厂读 ConfigRepository（活配置/型号表 stamp）——inject 首次实战，PENDING 语义替代手工排序 */
export const inject = ["config"];

declare module "cordis" {
  interface Context {
    /** LLM provider 工厂面（实例现造，语义见插件头注） */
    llm: LlmFactories;
  }
}

export function apply(ctx: Context): void {
  const configRepo = ctx.config;

  async function findProviderConfig(providerId: string | undefined) {
    if (!providerId) return undefined;
    const config = await configRepo.load();
    return config.providers.find((p) => p.id === providerId);
  }

  async function createProvider(agentConfig: AgentConfig) {
    if (process.env.NODE_ENV === "e2e") {
      return new MockLLMProvider();
    }
    if (!agentConfig.providerId) {
      return new ErrorLLMProvider(
        "尚未配置算力 Provider。请先在「算力平台」添加 Provider，再在本心智的设置中选择它。"
      );
    }
    const providerConfig = await findProviderConfig(agentConfig.providerId);
    if (!providerConfig) {
      logger.warn(
        `agent '${agentConfig.id}' references missing provider '${agentConfig.providerId}'`
      );
      return new ErrorLLMProvider(
        `配置的 Provider「${agentConfig.providerId}」不存在（可能已被删除），请在本心智的设置中重新选择。`
      );
    }
    const protocolOptions = {
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      requestTimeout: providerConfig.requestTimeout,
    };
    // 2026-08-08 协议族迁移：按 ProviderConfig.apiMode 实例化
    // responses / anthropic / chat_completions 适配器（缺省 chat_completions）。
    // 2026-08-10 B 方案：型号表存在 per-model apiMode 覆盖时按
    // (providerId, effectiveApiMode) 建/缓存适配器、chat 时按当前型号路由；
    // 型号无覆盖走既有 per-provider 单实例路径，行为完全不变。
    if (hasModelApiModeOverride(providerConfig)) {
      return new ModelApiModeRouter({
        providerId: providerConfig.id,
        provider: providerConfig,
        defaultModel: agentConfig.modelId || agentConfig.model || "gpt-4o",
        // R1（型号表热更新）：每次 chat/refresh 从 config.json 活配置解析生效
        // apiMode——型号表 PUT 加/改/删覆盖后下一次调用即走新协议，无需重启；
        // stamp 短缓存让配置未变时零读盘，变更时下一次调用立即感知
        resolveProvider: async () => {
          const config = await configRepo.load();
          return config.providers.find((p) => p.id === providerConfig.id);
        },
        getConfigFileStamp: () => configRepo.getConfigFileStamp(),
      });
    }
    return createProtocolProvider(providerConfig.apiMode, protocolOptions);
  }

  /** 降级链备用实例：按 providerId 创建；不存在则跳过（返回 undefined），不降级为 ErrorLLMProvider */
  async function createFallback(
    providerId: string,
    agentConfig: AgentConfig,
  ): Promise<{ provider: LLMProvider; config?: ProviderConfig } | undefined> {
    if (process.env.NODE_ENV === "e2e") {
      return { provider: new MockLLMProvider() };
    }
    const providerConfig = await findProviderConfig(providerId);
    if (!providerConfig) {
      logger.warn(`agent '${agentConfig.id}' 的备用 provider '${providerId}' 不存在，跳过`);
      return undefined;
    }
    const protocolOptions = {
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      requestTimeout: providerConfig.requestTimeout,
    };
    if (hasModelApiModeOverride(providerConfig)) {
      return {
        provider: new ModelApiModeRouter({
          providerId: providerConfig.id,
          provider: providerConfig,
          defaultModel: agentConfig.modelId || agentConfig.model || "gpt-4o",
          resolveProvider: async () => {
            const config = await configRepo.load();
            return config.providers.find((p) => p.id === providerConfig.id);
          },
          getConfigFileStamp: () => configRepo.getConfigFileStamp(),
        }),
        config: providerConfig,
      };
    }
    return {
      provider: createProtocolProvider(providerConfig.apiMode, protocolOptions),
      config: providerConfig,
    };
  }

  async function createEmbedder(agentConfig: AgentConfig) {
    if (process.env.NODE_ENV === "e2e" || !agentConfig.embedderProviderId) {
      return new MockEmbedderProvider();
    }
    const config = await configRepo.load();
    const providerConfig = config.providers.find((p) => p.id === agentConfig.embedderProviderId);
    if (!providerConfig) {
      return new MockEmbedderProvider();
    }
    // 型号从配置来（AgentConfig.embedderModelId → 编辑器「嵌入型号」）；缺省由
    // provider 自身回落 text-embedding-3-small。此前型号写死在 provider 里，
    // 配置了也不生效
    return new OpenAIEmbedderProvider(
      providerConfig.apiKey,
      providerConfig.baseUrl,
      agentConfig.embedderModelId,
    );
  }

  async function createImage(agentConfig: AgentConfig) {
    if (process.env.NODE_ENV === "e2e") {
      return new MockImageGenProvider();
    }
    // 决策 5：未配置 imageProviderId 的 agent 不造 provider（undefined）——
    // 工具的 imageProvider 守卫据此返回配置指引错误，而不是静默落盘 mock 图
    if (!agentConfig.imageProviderId) {
      return undefined;
    }
    const config = await configRepo.load();
    const providerConfig = config.providers.find((p) => p.id === agentConfig.imageProviderId);
    if (!providerConfig) {
      // 决策 5 同性质（主控裁定）：dangling 配置不静默造假图——Mock 只属于 e2e；
      // 返 undefined（工具守卫报配置指引）+ warn 一条（只带 id，不落正文）
      logger.warn(
        { agentId: agentConfig.id, imageProviderId: agentConfig.imageProviderId },
        "[llm] imageProviderId 在 config.providers 中查无此项，生图 provider 未装配",
      );
      return undefined;
    }
    // 决策 1：agentConfig.imageModelId 作为 provider 默认型号传入（工具参数 model 可临时覆盖）
    return new OpenAIImageGenProvider(providerConfig.apiKey, providerConfig.baseUrl, agentConfig.imageModelId);
  }

  ctx.provide("llm", {
    findProviderConfig,
    createProvider,
    createFallback,
    createEmbedder,
    createImage,
  } satisfies LlmFactories);
}

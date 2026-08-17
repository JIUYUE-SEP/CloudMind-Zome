import type { Context } from "cordis";
import { logger } from "../../logger.js";
import { AgentWorker } from "../../core/agent-worker.js";
import { WorkerRegistry } from "../../core/worker-registry.js";
import { withLLMCallRecording } from "../llm/record-calls.js";
import { LLMCallRepository } from "../../memory/repositories/llm-call.js";
import { MessageRepository } from "../../memory/repositories/message.js";
import { ResilientLLMProvider } from "../../provider/resilient.js";
import type { LLMProvider } from "../../provider/types.js";
import { MockEmbedderProvider } from "../../provider/embedder.js";
import { MemoryIndexer } from "../../memory/indexer.js";
import { loadTopicState } from "../../memory/topic/state.js";
import { getAgentDir } from "../../config/paths.js";
import type { AgentConfig, ProviderConfig } from "@mindcloud/shared";
import type { AgentRepository } from "../../memory/repositories/agent.js";
import type { SubagentDispatcher } from "../../subagent/dispatcher.js";
import type { SubagentSwarm } from "../../subagent/batch.js";
import type { PuppetModelService } from "../../subagent/puppet-models.js";
import type { IntermindService } from "../../intermind/service.js";
import type { SidecarClient } from "../../sidecar/client.js";

/**
 * agents 插件（P6 主峰）：人形的身体——per-agent worker 创建链收编。
 *
 * - ctx.agents 上架：agentRepository（来自 ctx.memory 的合体）、workerRegistry、
 *   getOrCreateWorker(agentId)、retire(agentId)；onChange→retire 接线收在
 *   插件内部（不再跨 bootstrap）。
 * - worker 创建链本体自 bootstrap.ts 迁入：provider 包装链 resilient(record())、
 *   embedder/image、tools 装配（ctx.tools.forAgent）、contextPipeline
 *   （ctx.pipeline + ctx.compute）、MemoryIndexer 现造、话题交接（topic-state
 *   读取 + restoreTopicOpen）——worker config 全字段语义一字未改。
 * - inject 全阵容：PENDING 语义真正替代手工排序——config/llm/tools/skills/
 *   memory/mind/pipeline/compute 全部就绪才激活。
 * - 过渡形态（P6 任务书批准）：worker services 字典里的 P7 模块（subagent/
 *   intermind 系）与 sidecarClient 经**插件 config 回调**进场（P3 skills 先例）。
 *   回调在 getOrCreateWorker 工厂内才被调用——**闭包延迟求值**，绝不在 apply
 *   时急切捕获（dispatcher 等依赖 runAgentCollect → getOrCreateWorker，急切
 *   构造会炸 TDZ，方案 B4 风险 1 的既定缓解）。
 */
export const name = "agents";

/** worker 创建链的全部 ctx 依赖（见头注） */
export const inject = ["config", "llm", "tools", "skills", "memory", "mind", "pipeline", "compute"];

/** 插件 config：P7 模块与 sidecar 的过渡进场（闭包延迟求值，见头注） */
export interface Config {
  getSubagentServices(): {
    subagentDispatcher: SubagentDispatcher;
    subagentSwarm: SubagentSwarm;
    puppetModelService: PuppetModelService;
    intermindService: IntermindService;
  };
  getSidecar(): SidecarClient;
}

/** ctx.agents 上架面 */
export interface AgentsFace {
  /** agent 配置仓库（来自 ctx.memory 的合体单例） */
  agentRepository: AgentRepository;
  /** worker 注册表：创建/替换/退役的唯一权威 */
  workerRegistry: WorkerRegistry;
  getOrCreateWorker(agentId: string): Promise<AgentWorker | undefined>;
  retire(agentId: string): void;
}

declare module "cordis" {
  interface Context {
    /** agents 服务面（见 AgentsFace） */
    agents: AgentsFace;
  }
}

export function apply(ctx: Context, config: Config): void {
  // 与 skills 插件同风格（P4 先例）：config 回调缺失即启动即炸
  if (typeof config?.getSubagentServices !== "function" || typeof config?.getSidecar !== "function") {
    throw new Error(
      "[agents] 插件 config 缺失：必须提供 getSubagentServices / getSidecar 回调（P6 批准的过渡形态）",
    );
  }

  const workerRegistry = new WorkerRegistry();
  const agentRepository = ctx.memory.agentRepository;
  const configRepo = ctx.config;

  // 配置变更退役接线（P3-6）：收进插件内部，不再跨 bootstrap
  agentRepository.onChange = (agentId: string, _config: AgentConfig | null) => {
    void _config;
    workerRegistry.retire(agentId);
  };

  async function getOrCreateWorker(agentId: string): Promise<AgentWorker | undefined> {
    return workerRegistry.getOrCreate(agentId, async () => {
      const agentConfig = await agentRepository.get(agentId);
      if (!agentConfig) return undefined;

      // 包装顺序 resilient( record( provider ) )：record 在内层，
      // 每次底层尝试（含重试、含备用）独立落档 llm_calls.jsonl
      const recordLLM = (p: LLMProvider, providerConfig?: ProviderConfig) =>
        withLLMCallRecording(p, new LLMCallRepository(agentId), agentId, {
          providerId: providerConfig?.id,
          providerName: providerConfig?.displayName ?? providerConfig?.id,
        });
      const primaryProviderConfig = await ctx.llm.findProviderConfig(agentConfig.providerId);
      const provider = new ResilientLLMProvider(
        recordLLM(await ctx.llm.createProvider(agentConfig), primaryProviderConfig),
        {
          maxRetries: primaryProviderConfig?.maxRetries ?? 2,
          fallbackProviderIds: agentConfig.fallbackProviderIds ?? [],
          fallbackFactory: async (id) => {
            const fallback = await ctx.llm.createFallback(id, agentConfig);
            return fallback ? recordLLM(fallback.provider, fallback.config) : undefined;
          },
        },
      );
      const embedder = await ctx.llm.createEmbedder(agentConfig);
      const imageProvider = await ctx.llm.createImage(agentConfig);
      const tools = ctx.tools.forAgent(agentConfig);
      const workspaceDir = getAgentDir(agentId);

      // G2（双源统一）：pipeline 预算与水位 W 同一查找链——型号表 contextWindow 优先
      // 驱动预算；查不到回退 agent 显式 maxContextTokens / 80_000（pipeline-factory 兜底）
      const resolvedContextWindow = await ctx.compute.resolveContextWindow(configRepo, {
        providerId: agentConfig.providerId,
        modelId: agentConfig.modelId || agentConfig.model || "gpt-4o",
      });
      const contextPipeline = ctx.pipeline.createContextPipelineForAgent(agentConfig, resolvedContextWindow);

      // 只有配置了真实 embedder 时才启用向量索引；Mock embedder 的随机向量没有检索意义
      const memoryIndexer =
        embedder instanceof MockEmbedderProvider ? undefined : new MemoryIndexer(config.getSidecar(), embedder);

      const worker = new AgentWorker({
        agentId,
        model: agentConfig.modelId || agentConfig.model || "gpt-4o",
        provider,
        tools,
        workspaceDir,
        messageRepository: new MessageRepository(agentId),
        // H1：工具调用落档（actions.jsonl 唯一写入方）——ctx.memory 工厂现造，与其他 repository 同语义
        actionRepository: ctx.memory.getActionRepository(agentId),
        approve: () => true,
        temperature: agentConfig.temperature,
        topP: agentConfig.topP,
        reactMaxSteps: agentConfig.reactMaxSteps,
        handoffMaxShifts: agentConfig.handoffMaxShifts,
        maxContextTokens: agentConfig.maxContextTokens,
        providerId: agentConfig.providerId,
        configRepository: configRepo,
        trustAllTools: agentConfig.trustAllTools,
        // P4：灵魂层消费改经 ctx.mind（装配层透传；worker 内不再 import mind/ 模块）
        mind: ctx.mind,
        // P5：W 查找链消费改经 ctx.compute（装配层透传）
        compute: ctx.compute,
        // L1 技能目录（阶段 5 一期：只注名字+一句话作发现入口，正文经 Skill 工具取回）
        skillCatalog: (await ctx.skills.list(agentId)).map((s) => `- ${s.name}：${s.description}`),
        memoryIndexer,
        embedder,
        imageProvider,
        // swarm 只接 worker（主人会话）；傀儡 runtime 故意不接——防嵌套批量（16×16）
        services: {
          // P7 模块经插件 config 回调进场（闭包延迟求值，见文件头注）
          ...config.getSubagentServices(),
          skillService: ctx.skills,
          configRepository: configRepo,
          recallService: ctx.memory.recall,
        },
        // M2 + G2：上下文预算由 W 查找链驱动（型号表 contextWindow），查不到接
        // agent 级配置（maxContextTokens），再缺省 80000
        contextPipeline,
        // H2：生产路径开启 pipeline 预算热更同步（compute 模型表 PUT 后无需重启/退役）
        contextPipelineHotSync: true,
        // Phase 2：话题压缩配置接 agent 级字段，缺省全开（30 分钟窗 / 20 条阈值 / 主模型压缩）
        topicCompression: {
          ...(agentConfig.compressionModel !== undefined ? { compressionModel: agentConfig.compressionModel } : {}),
          ...(agentConfig.topicBoundaryModel !== undefined
            ? { boundaryModel: agentConfig.topicBoundaryModel }
            : {}),
          ...(agentConfig.topicDetectionWindowMinutes !== undefined
            ? { windowMinutes: agentConfig.topicDetectionWindowMinutes }
            : {}),
          ...(agentConfig.topicMessageThreshold !== undefined
            ? { messageThreshold: agentConfig.topicMessageThreshold }
            : {}),
        },
        // Phase 3：语义检索配置接 agent 级字段，缺省全开（topK=10 / minScore=0）
        semanticSearch: {
          ...(agentConfig.semanticSearchEnabled !== undefined
            ? { enabled: agentConfig.semanticSearchEnabled }
            : {}),
          ...(agentConfig.semanticTopK !== undefined ? { topK: agentConfig.semanticTopK } : {}),
          ...(agentConfig.semanticMinScore !== undefined ? { minScore: agentConfig.semanticMinScore } : {}),
        },
      });
      // P3-6：TopicTracker 交接——被替换 worker 的开放话题快照（topic-state.json，
      // P1-2/M-b 按 step 落盘）重建进新 worker，话题边界状态不分叉。
      // 首次创建时文件通常不存在（启动对账已清理），读到即交接
      try {
        const topicState = await loadTopicState(agentId);
        if (topicState?.open && topicState.open.messageIds.length > 0) {
          const openMessages = await new MessageRepository(agentId).getByIds(topicState.open.messageIds);
          if (openMessages.length > 0) {
            worker.restoreTopicOpen(openMessages, topicState.open.sourceId, topicState.open.sourceName);
          }
        }
      } catch (err) {
        logger.warn({ err: err }, `[topic] worker 话题状态交接失败（跳过）：${agentId}`);
      }
      return worker;
    });
  }

  ctx.provide("agents", {
    agentRepository,
    workerRegistry,
    getOrCreateWorker,
    retire: (agentId: string) => workerRegistry.retire(agentId),
  } satisfies AgentsFace);
}

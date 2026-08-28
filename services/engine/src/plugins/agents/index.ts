import type { Context } from "cordis";
import { logger } from "../../logger.js";
import { AgentWorker } from "../../core/agent-worker.js";
import type {
  LLMRequestEvent,
  TurnStepEvent,
  TurnEndEvent,
  ToolApprovalEvent,
} from "../../core/agent-worker.js";
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
import { DynamicToolLoader } from "../../core/dynamic-tool-loader.js";
import { ToolBlurbStore } from "../../core/tool-blurb-store.js";
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
  interface Events {
    /**
     * @mode waterfall —— LLM 请求缝（P8b）：worker 回合内每次 provider.chat
     * 发起前经 agents 装配层派发；payload.messages 即请求本体引用（不落副本）。
     * 中间件 throw 或不调 next() 即否决本次请求（invariants A4-2 以
     * { prepend: true, global: true } 挂首棒，dsh invariant.ts 同款）；
     * 返回值不消费，改写通道 = 就地改 payload.messages。
     */
    "llm/request": (
      payload: LLMRequestEvent,
      next: () => LLMRequestEvent | Promise<LLMRequestEvent>,
    ) => LLMRequestEvent | Promise<LLMRequestEvent>;
    /**
     * @mode serial —— step 落盘 + 话题快照成功（P8b；worker onStepAppended
     * 包装内发）。v1 事件地图记 emit，落地改 serial：cordis emit 同步派发
     * 不等待异步监听（cordis lib 实证），invariants 的存储 read-back 是异步
     * 的，enforce 抛错要传回发射点必须按序等待——serial 按序 settle、错误
     * 原样上传；无监听时与 emit 等价空转（摘除断言插件即回结构性保证）。
     * 观察型消费者请保持轻量：监听耗时计入回合热路径。
     * 监听必须返回 undefined（或 resolve undefined 的 Promise）：cordis
     * serial 语义下任一监听返回真值即截断后续监听，本事件要求全部监听执行。
     */
    "turn/step": (payload: TurnStepEvent) => void | Promise<void>;
    /**
     * @mode serial —— 回合终止（含异常终止，与既有 turn.end 终帧语义一致；
     * worker processQueue finally 内发）。serial 理由同 turn/step。
     * 监听必须返回 undefined：返回真值即截断后续监听（同 turn/step）。
     */
    "turn/end": (payload: TurnEndEvent) => void | Promise<void>;
    /**
     * @mode serial —— 审批门每次决策后（P8b；worker approve 包装内发，
     * 决策逻辑本体不受事件影响）。serial 理由同 turn/step。
     * 监听必须返回 undefined：返回真值即截断后续监听（同 turn/step）。
     */
    "tool/approval": (payload: ToolApprovalEvent) => void | Promise<void>;
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
  // blurb 策展存储（spec v2 决策 2）：插件级单例（= 进程级），跨 agent/worker 复用
  const toolBlurbStore = new ToolBlurbStore();

  // 配置变更退役接线（P3-6）：收进插件内部，不再跨 bootstrap。
  // 可逆纪律例外自陈：这里是直接赋值而非 on/off 订阅——AgentRepository.onChange
  // 是单槽位属性（见 memory/repositories/agent.ts），本插件是其唯一接线方，
  // 覆盖赋值即完整替换，无残留监听需在 dispose 摘除，故不走「挂载可逆」的
  // 通用纪律。若未来出现第二接线方，须先把 onChange 改成多监听事件面，
  // 再改回订阅式接线
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
      // 决策 5 单一事实源收进 createImage（e2e Mock / 未配置 undefined / dangling
      // undefined+warn 三分支全在工厂内）；此处无条件透传，undefined 即不注入
      const imageProvider = await ctx.llm.createImage(agentConfig);
      const tools = ctx.tools.forAgent(agentConfig);
      const workspaceDir = getAgentDir(agentId);

      // blurb LLM 策展（spec v2 决策 1）：worker 构建内同步完成一次批量概括
      // （装配层 async 发起，走 agent 自己的 provider 链落 llm_calls 账）；
      // 无动态工具零调用零落盘；失败=缺席降级机械版，不阻塞 worker 创建
      const dynamicToolLoader = new DynamicToolLoader(tools);
      await dynamicToolLoader.ensureBlurbs(
        provider,
        agentConfig.modelId || agentConfig.model || "gpt-4o",
        toolBlurbStore,
      );

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
        dynamicToolLoader,
        messageRepository: new MessageRepository(agentId),
        // H1：工具调用落档（actions.jsonl 唯一写入方）——ctx.memory 工厂现造，与其他 repository 同语义
        actionRepository: ctx.memory.getActionRepository(agentId),
        // P4-a：长期记忆仓库（memory flush 落库 + L4 `mem:` 命中解析共用）
        memoryRepository: ctx.memory.getMemoryRepository(agentId),
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
        // P8b 事件缝：turn 三事件接事件总线（serial 派发——@mode 理由见上方
        // Events 声明）；无监听时零开销空转，摘除 invariants 即回结构性保证
        emitTurnEvent: async (type, payload) => {
          if (type === "turn/step") await ctx.serial("turn/step", payload as TurnStepEvent);
          else if (type === "turn/end") await ctx.serial("turn/end", payload as TurnEndEvent);
          else await ctx.serial("tool/approval", payload as ToolApprovalEvent);
        },
        // P8b 事件缝：llm/request waterfall（返回值不消费，payload.messages 即请求本体引用）
        onLLMRequest: async (payload) => {
          await ctx.waterfall("llm/request", payload, () => payload);
        },
        // P8b 事件缝：memory/archived 通道经 memory 插件 config 回调进场（过渡形态）
        onMemoryArchived: ctx.memory.onTopicArchived
          ? (ids) => ctx.memory.onTopicArchived!(agentId, ids)
          : undefined,
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
          // P4-c：双程压缩开关（Agent 级，缺省关）
          ...(agentConfig.twoPassCompression !== undefined
            ? { twoPass: agentConfig.twoPassCompression }
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

import type { Context } from "cordis";
import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import { SubagentDispatcher } from "../../subagent/dispatcher.js";
import { BackgroundManager } from "../../subagent/background.js";
import { SubagentTaskRepository } from "../../subagent/task-repository.js";
import { PuppetRunner, type PuppetRuntime } from "../../subagent/puppet.js";
import { createPuppetModelService, type PuppetModelService } from "../../subagent/puppet-models.js";
import { SubagentSwarm } from "../../subagent/batch.js";
import { createSubagentTerminalNotifier } from "../../subagent/notify.js";
import { withLLMCallRecording } from "../llm/record-calls.js";
import { LLMCallRepository } from "../../memory/repositories/llm-call.js";
import { ResilientLLMProvider } from "../../provider/resilient.js";
import type { LLMProvider } from "../../provider/types.js";
import { getAgentDir } from "../../config/paths.js";
import type { ChatMessage, ProviderConfig } from "@mindcloud/shared";

/**
 * subagents 插件（P7d 收尾）：subagent 调度链路 + 傀儡执行路径收编上架
 * ctx.subagents。
 *
 * - 装配自 bootstrap.ts 逐字迁入（构造顺序与闭包延迟求值形态不变）：
 *   puppetModelService → runAgentCollect（经 AgentWorker 队列，独立
 *   subagent_<uuid> 会话）→ puppetRunner（provider 包装链 resilient(record())，
 *   工具装配 ctx.tools.forAgent）→ backgroundManager（终态通知接
 *   getAgentConfig/injectNotice——P8a 起经 perception 单口注入）→ subagentDispatcher → subagentSwarm。
 * - puppetRunner.getRuntime 的 services 字典里 subagentDispatcher 保持闭包
 *   延迟求值：同 apply 内构造，TDZ 安全由 lazy 闭包保证，不得急切捕获
 *   （方案 B4 风险 1 的既定缓解）。
 * - 启动对账 backgroundManager.load() 收进本 apply：async apply 由 fiber 激活
 *   等待，await ctx.plugin(subagentsPlugin) 保持原 bootstrap「listen 前对账」
 *   时序（handoff P7b / tools P3 connectAll 同款先例；bootstrap 不再调 load）。
 * - agents↔subagents 环：agents 插件不 inject subagents；其 worker services
 *   字典经 config 回调闭包延迟求值取 root.subagents.*（回调在首个 worker
 *   创建时才被调用，挂载顺序安全）。
 */
export const name = "subagents";

/** 调度链路的全部 ctx 依赖（见头注；agents 面含 worker 创建链与合体仓库；perception 为 P8a 终态通知注入单口） */
export const inject = ["config", "llm", "tools", "compute", "agents", "memory", "intermind", "perception"];

/** ctx.subagents 上架面 */
export interface SubagentsFace {
  /** 子 agent 派发器（dispatch_subagent 工具经 services 字典、REST 路由共用） */
  dispatcher: SubagentDispatcher;
  /** 后台任务管理器（启动对账 load() 已在 apply 内完成） */
  backgroundManager: BackgroundManager;
  /** swarm 批量派发（全傀儡成员，无审批桥接，写类 fail-closed） */
  swarm: SubagentSwarm;
  /** Puppet 型号库（内置四型号 + DATA_DIR/puppet-models/*.json 自定义） */
  puppetModelService: PuppetModelService;
  /** 经 AgentWorker 队列运行一轮对话并收集最终文本（subagent/plan 执行共用） */
  runAgentCollect(
    agentId: string,
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): Promise<string>;
}

declare module "cordis" {
  interface Context {
    /** subagent 调度链路服务面（见 SubagentsFace） */
    subagents: SubagentsFace;
  }
}

export async function apply(ctx: Context): Promise<void> {
  // agentRepository 取 agents 面合体单例（即 ctx.memory 同一实例，语义不变）；
  // configRepo/recallService 留局部别名，下方迁入装配一字不动
  const agentRepository = ctx.agents.agentRepository;
  const configRepo = ctx.config;
  const recallService = ctx.memory.recall;

  // Puppet 型号库（单 3）：内置四型号 + DATA_DIR/puppet-models/*.json 自定义（同名覆盖）
  const puppetModelService = createPuppetModelService();

  // subagent 调度链路：runAgentCollect 经 AgentWorker 队列执行（保持串行不变量），
  // dispatcher/background 为全局单例，同时暴露给工具上下文与 REST 路由。
  async function runAgentCollect(
    agentId: string,
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const worker = await ctx.agents.getOrCreateWorker(agentId);
    if (!worker) throw new Error(`Agent ${agentId} not found`);
    // 独立 sessionId，避免子 agent 任务污染私聊会话历史
    const taskId = `subagent_${randomUUID()}`;
    // P8b（A4-2 缺口补齐）：先落盘后入队——subagent 前台/后台与 plans 执行
    // 的构造输入消息此前不入存储（模型可见不可重建：turn/end 的 A4-2③
    // 运行时断言会判违例；向量索引引用的消息 id 也无存储本体）。与
    // runScheduledTask 同一序补齐：保留原消息 id（话题压缩归档按 id 匹配
    // 热存储），落盘失败记档仍入队（任务执行语义不变）
    const messageRepository = ctx.memory.getMessageRepository(agentId);
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      await messageRepository
        .append({
          id: msg.id || randomUUID(),
          sessionId: taskId,
          role: "user",
          content: msg.content,
          createdAt: msg.createdAt,
        })
        .catch((err) => {
          logger.error({ err: err }, "failed to persist subagent user message");
        });
    }
    return new Promise<string>((resolve, reject) => {
      let text = "";
      worker.enqueue({
        id: taskId,
        sessionId: taskId,
        messages,
        signal: opts?.signal,
        onEvent: (event) => {
          if (event.type === "text.delta") text += event.delta;
        },
        onDone: (err) => (err ? reject(err) : resolve(text)),
      });
    });
  }

  // puppet 执行路径（2b）：傀儡 = 调用方的一次性分身（无 SOUL/无记忆/记忆即弃），
  // provider/model/工具复用 worker 创建链（resilient(record(provider))，含 MCP 工具），
  // LLM 调用落档记 owner；不走 AgentWorker，runTurn 裸跑
  const puppetRunner = new PuppetRunner({
    getPuppetModel: (name) => puppetModelService.get(name),
    getRuntime: async (ownerAgentId): Promise<PuppetRuntime | undefined> => {
      const agentConfig = await agentRepository.get(ownerAgentId);
      if (!agentConfig) return undefined;
      const recordLLM = (p: LLMProvider, providerConfig?: ProviderConfig) =>
        withLLMCallRecording(p, new LLMCallRepository(ownerAgentId), ownerAgentId, {
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
      return {
        provider,
        model: agentConfig.modelId || agentConfig.model || "gpt-4o",
        providerId: agentConfig.providerId,
        maxContextTokens: agentConfig.maxContextTokens,
        configRepository: configRepo,
        compute: ctx.compute,
        tools: ctx.tools.forAgent(agentConfig),
        workspaceDir: getAgentDir(ownerAgentId),
        services: {
          // 闭包延迟求值（见头注）：getRuntime 被调用时下方 dispatcher 已就位
          subagentDispatcher,
          configRepository: configRepo,
          puppetModelService,
          intermindService: ctx.intermind,
          recallService,
        },
      };
    },
  });

  const backgroundManager = new BackgroundManager(
    {
      runAgent: runAgentCollect,
      runPuppet: (ownerAgentId, taskDescription, opts) =>
        puppetRunner.run(ownerAgentId, taskDescription, {
          signal: opts?.signal,
          puppetModel: opts?.puppetModel,
        }),
      // 终态通知（阶段 4）：任务 completed/failed → perception 单口注入 owner
      // 感知回合（P8a；开关 AgentConfig.subagentNotify 缺省开；失败记 warn 不炸收尾）
      onTaskTerminal: createSubagentTerminalNotifier({
        getAgentConfig: (agentId) => agentRepository.get(agentId),
        injectNotice: (payload) => ctx.perception.injectNotice(payload),
      }),
    },
    new SubagentTaskRepository(),
  );
  const subagentDispatcher = new SubagentDispatcher({
    getAgentConfig: (agentId) => agentRepository.get(agentId),
    runAgent: runAgentCollect,
    background: backgroundManager,
    puppet: puppetRunner,
  });

  // swarm 批量派发（阶段 3）：全傀儡成员（无审批桥接，写类 fail-closed），
  // 调度核 AgentRunBatch 的 Launcher 接 PuppetRunner，任务记录进同一后台任务表
  const subagentSwarm = new SubagentSwarm({
    getAgentConfig: (agentId) => agentRepository.get(agentId),
    runPuppet: (ownerAgentId, prompt, opts) =>
      puppetRunner.run(ownerAgentId, prompt, { signal: opts?.signal }),
    background: backgroundManager,
  });

  // subagent 后台任务启动对账：持久化记录回填内存索引，running 一律标 lost
  // （重启语义：现场已毁、不知死活≠已知失败，交人工决策而非自动续跑）。
  // 收进 apply（见头注）：apply 完成即对账完成，listen 前对账时序不变
  await backgroundManager.load();

  ctx.provide("subagents", {
    dispatcher: subagentDispatcher,
    backgroundManager,
    swarm: subagentSwarm,
    puppetModelService,
    runAgentCollect,
  } satisfies SubagentsFace);
}

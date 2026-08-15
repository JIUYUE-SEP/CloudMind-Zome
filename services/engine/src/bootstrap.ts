import { logger } from "./logger.js";
import { createServer } from "./api/server.js";
import { Context } from "cordis";
import * as logPlugin from "./plugins/log/index.js";
import * as configPlugin from "./plugins/config/index.js";
import * as llmPlugin from "./plugins/llm/index.js";
import * as toolsPlugin from "./plugins/tools/index.js";
import * as skillsPlugin from "./plugins/skills/index.js";
import * as memoryPlugin from "./plugins/memory/index.js";
import * as mindPlugin from "./plugins/mind/index.js";
import { findBuiltinSkillsDir } from "./plugins/skills/index.js";
import { assertServices } from "./plugins/require-services.js";
import { MessageRepository } from "./memory/repositories/message.js";
import { MemoryRepository } from "./memory/repositories/memory.js";
import { ActionRepository } from "./memory/repositories/action.js";
import { LLMCallRepository } from "./memory/repositories/llm-call.js";
import { SessionRepository } from "./conductor/repository.js";
import { ResilientLLMProvider } from "./provider/resilient.js";
import type { LLMProvider } from "./provider/types.js";
import { MockEmbedderProvider } from "./provider/embedder.js";
import { AgentWorker } from "./core/agent-worker.js";
import { createContextPipelineForAgent } from "./core/pipeline-factory.js";
import { resolveContextWindow } from "./compute/context-window.js";
import type { ApiContext } from "./api/context.js";
import type { AgentConfig, ChatMessage, ProviderConfig } from "@mindcloud/shared";
import { getAgentDir, getDataDir } from "./config/paths.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { BlueprintRepository } from "./blueprint/repository.js";
import { loadSkills } from "./skills/loader.js";
import { SidecarClient } from "./sidecar/client.js";
import { MemoryIndexer } from "./memory/indexer.js";
import { loadTopicState } from "./memory/topic/state.js";
import { registerShutdownHandlers } from "./shutdown.js";
import { PlanManager } from "./plan/manager.js";
import { PlanRepository } from "./plan/repository.js";
import { SubagentDispatcher } from "./subagent/dispatcher.js";
import { BackgroundManager } from "./subagent/background.js";
import { SubagentTaskRepository } from "./subagent/task-repository.js";
import { PuppetRunner, type PuppetRuntime } from "./subagent/puppet.js";
import { createPuppetModelService } from "./subagent/puppet-models.js";
import { IntermindService } from "./intermind/service.js";
import { SubagentSwarm } from "./subagent/batch.js";
import { createSubagentTerminalNotifier } from "./subagent/notify.js";
import { HandoffManager } from "./handoff/manager.js";
import { HandoffStateStore } from "./handoff/state.js";
import { HandoffLoopRegistry } from "./handoff/registry.js";
import { WorkerRegistry } from "./core/worker-registry.js";
import { withLLMCallRecording } from "./plugins/llm/record-calls.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getAuthToken, getAuthTokenFilePath } from "./config/auth-token.js";
import { classifyListenError } from "./api/listen-error.js";
import { getGitShortHash } from "./git-commit.js";
import { DEFAULT_ENGINE_PORT } from "@mindcloud/shared";

// findBuiltinSkillsDir 已迁入 skills 插件（P3：plugins/skills/index.ts，
// 三分支语义一字未改）；本文件的 ApiContext.listSkills 经 import 复用。

async function main() {
  // Cordis 组合根（P1 起）：插件挂载，实例从 ctx 取回继续喂现有
  // 手工接线；其余接线一行不动，后续期逐期收口
  // （docs/superpowers/plans/2026-08-14-cordis-plugin-migration.md）
  const root = new Context();
  await root.plugin(logPlugin);
  await root.plugin(configPlugin);
  await root.plugin(llmPlugin);
  // tools（P3）：MCP connectAll 在插件 apply 内完成（启动时序不变）；
  // fiber 引用留给关停钩——close 挂插件 disposer
  const toolsFiber = await root.plugin(toolsPlugin);
  // memory/mind（P4）：mind 的领域数据落在 document-store（memory 插件内部实现），
  // 概念基座先行；两者 inject 皆空（document-store 为库级直 import，不经 ctx）
  await root.plugin(memoryPlugin);
  await root.plugin(mindPlugin);
  const configRepo = root.config;
  // agentRepository 实例改经 ctx.memory 取（P4；agents 服务的配置半边，
  // P6 才与 WorkerRegistry 合体为 agents 插件——本期只换来源）
  const agentRepository = root.memory.agentRepository;
  // worker 注册表（P3-6）：创建/替换/退役的唯一权威
  const workerRegistry = new WorkerRegistry();

  agentRepository.onChange = (agentId: string, _config: AgentConfig | null) => {
    void _config;
    workerRegistry.retire(agentId);
  };

  const sidecarClient = new SidecarClient();

  // skills 插件（P3）：getAgentConfig 依赖 agentRepository（P4/P6 才插件化）——
  // 批准的过渡形态：经插件 config 回调进场，后续期换位 inject
  await root.plugin(skillsPlugin, { getAgentConfig: (agentId) => agentRepository.get(agentId) });

  // fail-fast 断言（P3 任务 0）：cordis 对 PENDING 纤维的 await plugin() 立即落定
  // （promise 兑现 ≠ 激活）——挂载完成即断言就位，缺失启动即炸，不带病进运行时。
  // 维护责任：每期插件化新服务后，把自己那行加进下面列表。
  assertServices(root, ["log", "config", "llm", "tools", "skills", "memory", "mind"]);

  // 技能服务实例来自 ctx.skills 插件（P3）；下游引用面（worker services/ApiContext）不变
  const skillService = root.skills;

  // 回忆服务（recall 工具）实例改经 ctx.memory 取（P4 上架）；下游引用面不变
  const recallService = root.memory.recall;
  // Puppet 型号库（单 3）：内置四型号 + DATA_DIR/puppet-models/*.json 自定义（同名覆盖）
  const puppetModelService = createPuppetModelService();
  // Intermind 人形间私信（一期）：写信/唤醒/会话检索（getOrCreateWorker 为函数声明，可提前引用）
  const intermindService = new IntermindService({
    getAgentConfig: (agentId) => agentRepository.get(agentId),
    getMessageRepository: (agentId) => new MessageRepository(agentId),
    getAgentWorker: (agentId) => getOrCreateWorker(agentId),
  });

  // MCP servers 生命周期已收编进 tools 插件（P3）：loadDefault+connectAll 在
  // 插件 apply 内完成（启动时序不变），close 挂插件 disposer（关停钩 dispose 触发）；
  // ApiContext 的 mcpManager 经 root.tools.manager 透传。

  // subagent 调度链路：runAgentCollect 经 AgentWorker 队列执行（保持串行不变量），
  // dispatcher/background 为全局单例，同时暴露给工具上下文与 REST 路由。
  async function runAgentCollect(
    agentId: string,
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const worker = await getOrCreateWorker(agentId);
    if (!worker) throw new Error(`Agent ${agentId} not found`);
    // 独立 sessionId，避免子 agent 任务污染私聊会话历史
    const taskId = `subagent_${randomUUID()}`;
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
      const primaryProviderConfig = await root.llm.findProviderConfig(agentConfig.providerId);
      const provider = new ResilientLLMProvider(
        recordLLM(await root.llm.createProvider(agentConfig), primaryProviderConfig),
        {
          maxRetries: primaryProviderConfig?.maxRetries ?? 2,
          fallbackProviderIds: agentConfig.fallbackProviderIds ?? [],
          fallbackFactory: async (id) => {
            const fallback = await root.llm.createFallback(id, agentConfig);
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
        tools: root.tools.forAgent(agentConfig),
        workspaceDir: getAgentDir(ownerAgentId),
        services: {
          subagentDispatcher,
          configRepository: configRepo,
          puppetModelService,
          intermindService,
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
      // 终态通知（阶段 4）：任务 completed/failed → owner worker 注入感知回合
      // （开关 AgentConfig.subagentNotify 缺省开；失败记 warn 不炸收尾）
      onTaskTerminal: createSubagentTerminalNotifier({
        getAgentConfig: (agentId) => agentRepository.get(agentId),
        getWorker: getOrCreateWorker,
      }),
    },
    new SubagentTaskRepository(),
  );
  // 换班移交控制面（水位撞顶=换班不死）：handoff-state.json 持久化 + 状态机
  const handoffManager = new HandoffManager({ store: new HandoffStateStore() });
  // 活跃续跑循环注册表（P1-1）：REST DELETE /handoff/:id 打断 running 期 job 的桥梁
  const handoffLoopRegistry = new HandoffLoopRegistry();
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

  const planManagers = new Map<string, PlanManager>();
  async function getPlanManager(agentId: string): Promise<PlanManager | undefined> {
    const existing = planManagers.get(agentId);
    if (existing) return existing;
    const agentConfig = await agentRepository.get(agentId);
    if (!agentConfig) return undefined;
    const manager = new PlanManager(
      {
        provider: await root.llm.createProvider(agentConfig),
        model: agentConfig.modelId || agentConfig.model || "gpt-4o",
      },
      new PlanRepository(agentId),
    );
    // 从 plans.jsonl 恢复历史 plan（running 步骤回退 pending，见 PlanManager.load）
    await manager.load();
    planManagers.set(agentId, manager);
    return manager;
  }

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
      const primaryProviderConfig = await root.llm.findProviderConfig(agentConfig.providerId);
      const provider = new ResilientLLMProvider(
        recordLLM(await root.llm.createProvider(agentConfig), primaryProviderConfig),
        {
          maxRetries: primaryProviderConfig?.maxRetries ?? 2,
          fallbackProviderIds: agentConfig.fallbackProviderIds ?? [],
          fallbackFactory: async (id) => {
            const fallback = await root.llm.createFallback(id, agentConfig);
            return fallback ? recordLLM(fallback.provider, fallback.config) : undefined;
          },
        },
      );
      const embedder = await root.llm.createEmbedder(agentConfig);
    const imageProvider = await root.llm.createImage(agentConfig);
    const tools = root.tools.forAgent(agentConfig);
    const workspaceDir = getAgentDir(agentId);

    // G2（双源统一）：pipeline 预算与水位 W 同一查找链——型号表 contextWindow 优先
    // 驱动预算；查不到回退 agent 显式 maxContextTokens / 80_000（pipeline-factory 兜底）
    const resolvedContextWindow = await resolveContextWindow(configRepo, {
      providerId: agentConfig.providerId,
      modelId: agentConfig.modelId || agentConfig.model || "gpt-4o",
    });
    const contextPipeline = createContextPipelineForAgent(agentConfig, resolvedContextWindow);

    // 只有配置了真实 embedder 时才启用向量索引；Mock embedder 的随机向量没有检索意义
    const memoryIndexer =
      embedder instanceof MockEmbedderProvider ? undefined : new MemoryIndexer(sidecarClient, embedder);

    const worker = new AgentWorker({
      agentId,
      model: agentConfig.modelId || agentConfig.model || "gpt-4o",
      provider,
      tools,
      workspaceDir,
      messageRepository: new MessageRepository(agentId),
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
      mind: root.mind,
      // L1 技能目录（阶段 5 一期：只注名字+一句话作发现入口，正文经 Skill 工具取回）
      skillCatalog: (await skillService.list(agentId)).map((s) => `- ${s.name}：${s.description}`),
      memoryIndexer,
      embedder,
      imageProvider,
      // swarm 只接 worker（主人会话）；傀儡 runtime 故意不接——防嵌套批量（16×16）
      services: {
        subagentDispatcher,
        subagentSwarm,
        skillService,
        configRepository: configRepo,
        puppetModelService,
        intermindService,
        recallService,
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

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: configRepo,
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: getOrCreateWorker,
    getPlanManager,
    runAgentCollect,
    subagentDispatcher,
    backgroundManager,
    handoffManager,
    handoffLoops: handoffLoopRegistry,
    mcpManager: root.tools.manager,
    // P1-3：删除 agent 时经 sidecar DeleteAgent 级联清理向量索引
    sidecarClient,
    skillService,
    puppetModelService,
    intermindService,
    mind: root.mind,
    retireAgentWorker: (agentId) => workerRegistry.retire(agentId),
    listSkills: async () => {
      const dirs: string[] = [];
      const builtin = await findBuiltinSkillsDir();
      if (builtin) dirs.push(builtin);
      dirs.push(path.join(getDataDir(), "skills"));
      const skills = await loadSkills({ builtinDirs: dirs });
      return skills.map((s) => ({ name: s.name, description: s.description, version: s.version }));
    },
  };

  const scheduler = new Scheduler(context, { pollIntervalMs: 5000 });

  // subagent 后台任务启动对账：持久化记录回填内存索引，running 一律标 lost
  // （重启语义：现场已毁、不知死活≠已知失败，交人工决策而非自动续跑）
  await backgroundManager.load();
  // 换班控制面启动对账：活跃续跑条目标 lost（重启后不自动续跑，交接书仍在历史）
  await handoffManager.load();

  // 启动对账（Phase 2 M3）：补归档"已有压缩档但仍留在热存储"的孤儿消息。
  // 在 scheduler/worker 产生新流量前完成；单 agent 失败只记 warn，不阻断启动。
  // ZOME_STARTUP_RECONCILE=false 可关闭（手动管理热存储的场景）。
  if (process.env.ZOME_STARTUP_RECONCILE !== "false") {
    const agents = await agentRepository.list();
    for (const agent of agents) {
      try {
        const repo = new MessageRepository(agent.id);
        const count = await root.memory.reconcileHotStorage(agent.id, repo);
        if (count > 0) {
          logger.info(`[reconcile] agent=${agent.id} 补归档孤儿消息 ${count} 条`);
        }
        // P1-2：重启孤儿（退出时仍在未关闭话题里的消息）。先查 topic-state.json
        // （廉价文件读），有孤儿才构造 LLM provider 补压缩/归档
        const orphanState = await loadTopicState(agent.id);
        const hasOpen = orphanState?.open && orphanState.open.messageIds.length > 0;
        const hasPending = (orphanState?.pending ?? []).length > 0;
        if (hasOpen || hasPending) {
          const providerConfig = await root.llm.findProviderConfig(agent.providerId);
          const deps = {
            agentId: agent.id,
            // P4 review Minor-2：reconcile 孤儿压缩同样经 record-calls 落档，与主链路一致
            provider: withLLMCallRecording(
              await root.llm.createProvider(agent),
              new LLMCallRepository(agent.id),
              agent.id,
              {
                providerId: providerConfig?.id,
                providerName: providerConfig?.displayName ?? providerConfig?.id,
              },
            ),
            model: agent.compressionModel || agent.modelId || agent.model || "gpt-4o",
            boundaryModel:
              agent.topicBoundaryModel ||
              agent.compressionModel ||
              agent.modelId ||
              agent.model ||
              "gpt-4o",
            messageRepository: repo,
            // P4：compression-task 已 inject 化，mind 能力从 ctx.mind 取下喂入
            mind: root.mind,
          };
          // M-b：先补"已关闭已入队未压缩"的 pending 段（desktop /F 主路径缺口）
          if (hasPending) {
            const pendingCount = await root.memory.reconcilePendingSegments(agent.id, repo, deps);
            if (pendingCount > 0) {
              logger.info(`[reconcile] agent=${agent.id} 补处理 pending 压缩段消息 ${pendingCount} 条`);
            }
          }
          if (hasOpen) {
            const orphanCount = await root.memory.reconcileOrphanedTopic(agent.id, repo, deps);
            if (orphanCount > 0) {
              logger.info(`[reconcile] agent=${agent.id} 处理重启孤儿消息 ${orphanCount} 条`);
            }
          }
        }
      } catch (err) {
        logger.warn({ err: err }, `[reconcile] agent=${agent.id} 对账失败，跳过（不阻断启动）`);
      }
    }
  }

  scheduler.start();

  const app = await createServer(context);
  // 在 listen 前确保 token 已就绪/落盘：desktop Rust 侧等 /health 通过后
  // 立即读 auth-token 文件下发给前端，晚于 listen 生成会引入竞态
  await getAuthToken();
  if (!process.env.CLOUDMIND_AUTH_TOKEN) {
    logger.info(
      `[auth] 本地鉴权 token 文件：${getAuthTokenFilePath()}（web 开发请设 NUXT_PUBLIC_ENGINE_TOKEN 或 localStorage cloudmind.engineToken）`,
    );
  }
  const port = Number(process.env.PORT || DEFAULT_ENGINE_PORT);
  const gitCommit = getGitShortHash();
  try {
    await app.listen({ port, host: "127.0.0.1" });
  } catch (err) {
    // EADDRINUSE 以独立 exit code 2 退出（普通崩溃是 1）：
    // supervisor 据此区分端口冲突与崩溃，不盲目高频重启
    const classified = classifyListenError(err, port, gitCommit);
    if (classified) {
      logger.error(classified.message);
      process.exit(classified.exitCode);
    }
    throw err;
  }
  const addr = app.server.address();
  const addrStr =
    typeof addr === "string"
      ? addr
      : addr
        ? `${addr.address}:${addr.port}`
        : "unknown";
  // S1：启动 banner 带 git 短哈希（代码版本），无 git 时省略该字段不崩
  logger.info(
    {
      addr: addrStr,
      ...(gitCommit !== undefined ? { gitCommit } : {}),
    },
    `Engine listening on ${addrStr}${gitCommit !== undefined ? ` (git ${gitCommit})` : ""}`,
  );

  // 优雅关停（P1-2）：SIGTERM/SIGINT 时先 drain 全部 worker 的压缩队列再退出
  // （超时 10s 兜底，不卡死关停）。Windows desktop 的 taskkill /F 强杀不会触发
  // 本 handler——那条路径的重启孤儿由上面的启动对账兜底。
  registerShutdownHandlers({
    drain: async () => {
      await Promise.allSettled([...workerRegistry.all()].map((w) => w.drainCompression()));
    },
    close: async () => {
      scheduler.stop();
      // MCP close 挂 tools 插件 disposer（P3 可逆注册首个真实用例）：
      // dispose 该 fiber 即触发 effect 清理（含 mcpManager.close()）
      await toolsFiber.dispose();
      await app.close();
    },
    timeoutMs: 10_000,
  });
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});

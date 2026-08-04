import { logger } from "./logger.js";
import { createServer } from "./api/server.js";
import { AgentRepository } from "./memory/repositories/agent.js";
import { MessageRepository } from "./memory/repositories/message.js";
import { MemoryRepository } from "./memory/repositories/memory.js";
import { ActionRepository } from "./memory/repositories/action.js";
import { LLMCallRepository } from "./memory/repositories/llm-call.js";
import { ConfigRepository } from "./config/repository.js";
import { resolveConfiguredTools } from "./config/agent-tools.js";
import { SessionRepository } from "./conductor/repository.js";
import { OpenAIProvider, MockLLMProvider, ErrorLLMProvider } from "./provider/llm.js";
import { ResilientLLMProvider } from "./provider/resilient.js";
import type { LLMProvider } from "./provider/types.js";
import { OpenAIEmbedderProvider, MockEmbedderProvider } from "./provider/embedder.js";
import { OpenAIImageGenProvider, MockImageGenProvider } from "./provider/image-gen.js";
import { AgentWorker } from "./core/agent-worker.js";
import { createContextPipelineForAgent } from "./core/pipeline-factory.js";
import { getBuiltinTools } from "./tools/builtin/index.js";
import { McpClientManager } from "./tools/mcp/index.js";
import type { ApiContext } from "./api/context.js";
import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import { getAgentDir, getDataDir } from "./config/paths.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { BlueprintRepository } from "./blueprint/repository.js";
import { loadSkills } from "./skills/loader.js";
import { createSkillService } from "./skills/service.js";
import { SidecarClient } from "./sidecar/client.js";
import { MemoryIndexer } from "./memory/indexer.js";
import { reconcileHotStorage, reconcileOrphanedTopic, reconcilePendingSegments } from "./memory/reconcile.js";
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
import { WorkerRegistry } from "./core/worker-registry.js";
import { withLLMCallRecording } from "./provider/record-calls.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAuthToken, getAuthTokenFilePath } from "./config/auth-token.js";
import { classifyListenError } from "./api/listen-error.js";
import { DEFAULT_ENGINE_PORT } from "@mindcloud/shared";

/** 从 cwd 向上找 monorepo 根下的 packages/skills（内置技能目录） */
async function findBuiltinSkillsDir(): Promise<string | undefined> {
  // env 兜底（功能 review M4）：与 ZOME_PROTO_PATH 同一模式——生产包内
  // 向上查找不命中时，可显式指向内置目录，不再静默丢失
  const fromEnv = process.env.ZOME_BUILTIN_SKILLS_DIR;
  if (fromEnv) {
    const ok = await fs.stat(fromEnv).then((s) => s.isDirectory()).catch(() => false);
    if (ok) return fromEnv;
    logger.warn(`[skills] ZOME_BUILTIN_SKILLS_DIR 指向的目录不存在：${fromEnv}（回退向上查找）`);
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "packages", "skills");
    const ok = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (ok) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 内置目录缺失此前静默吞掉（loader 对不存在目录 catch 跳过），打包排障零线索
  logger.warn(`[skills] 未找到内置技能目录 packages/skills（cwd=${process.cwd()} 向上 6 级不命中），内置 skill 不可用`);
  return undefined;
}

async function main() {
  const configRepo = new ConfigRepository();
  const agentRepository = new AgentRepository();
  // worker 注册表（P3-6）：创建/替换/退役的唯一权威
  const workerRegistry = new WorkerRegistry();

  agentRepository.onChange = (agentId: string, _config: AgentConfig | null) => {
    void _config;
    workerRegistry.retire(agentId);
  };

  const sidecarClient = new SidecarClient();

  // 技能服务（阶段 5 一期，Skill 工具化）：L1 目录（发现入口）与 Skill 工具
  // （取规程正文）共用同一套三级目录加载
  const skillService = createSkillService({
    getAgentConfig: (agentId) => agentRepository.get(agentId),
    resolveDirs: async (agentId) => {
      const dirs: string[] = [];
      const builtin = await findBuiltinSkillsDir();
      if (builtin) dirs.push(builtin);
      dirs.push(path.join(getDataDir(), "skills"));
      dirs.push(path.join(getAgentDir(agentId), "skills"));
      return dirs;
    },
  });
  // Puppet 型号库（单 3）：内置四型号 + DATA_DIR/puppet-models/*.json 自定义（同名覆盖）
  const puppetModelService = createPuppetModelService();
  // Intermind 人形间私信（一期）：写信/唤醒/会话检索（getOrCreateWorker 为函数声明，可提前引用）
  const intermindService = new IntermindService({
    getAgentConfig: (agentId) => agentRepository.get(agentId),
    getMessageRepository: (agentId) => new MessageRepository(agentId),
    getAgentWorker: (agentId) => getOrCreateWorker(agentId),
  });

  // MCP servers：启动时按 DATA_DIR/mcp-servers.json 连接，单个失败降级不影响整体
  const mcpManager = McpClientManager.loadDefault();
  await mcpManager.connectAll();

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
      const recordLLM = (p: LLMProvider) =>
        withLLMCallRecording(p, new LLMCallRepository(ownerAgentId), ownerAgentId);
      const primaryProviderConfig = await findProviderConfig(agentConfig.providerId);
      const provider = new ResilientLLMProvider(recordLLM(await createLLMProvider(agentConfig)), {
        maxRetries: primaryProviderConfig?.maxRetries ?? 2,
        fallbackProviderIds: agentConfig.fallbackProviderIds ?? [],
        fallbackFactory: async (id) => {
          const fallback = await createFallbackLLMProvider(id, agentConfig);
          return fallback ? recordLLM(fallback) : undefined;
        },
      });
      return {
        provider,
        model: agentConfig.modelId || agentConfig.model || "gpt-4o",
        tools: [
          ...getBuiltinTools().filter((t) => resolveConfiguredTools(agentConfig).includes(t.name)),
          // MCP 工具动态命名（mcp__ 前缀），与 worker 同一份快照
          ...mcpManager.getTools(),
        ],
        workspaceDir: getAgentDir(ownerAgentId),
        services: {
          subagentDispatcher,
          configRepository: configRepo,
          puppetModelService,
          intermindService,
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
        provider: await createLLMProvider(agentConfig),
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
      const recordLLM = (p: LLMProvider) =>
        withLLMCallRecording(p, new LLMCallRepository(agentId), agentId);
      const primaryProviderConfig = await findProviderConfig(agentConfig.providerId);
      const provider = new ResilientLLMProvider(recordLLM(await createLLMProvider(agentConfig)), {
        maxRetries: primaryProviderConfig?.maxRetries ?? 2,
        fallbackProviderIds: agentConfig.fallbackProviderIds ?? [],
        fallbackFactory: async (id) => {
          const fallback = await createFallbackLLMProvider(id, agentConfig);
          return fallback ? recordLLM(fallback) : undefined;
        },
      });
      const embedder = await createEmbedderProvider(agentConfig);
    const imageProvider = await createImageProvider(agentConfig);
    const tools = [
      ...getBuiltinTools().filter((t) => resolveConfiguredTools(agentConfig).includes(t.name)),
      // MCP 工具动态命名（mcp__ 前缀），不参与 agent 配置白名单过滤，与内置工具同管线
      ...mcpManager.getTools(),
    ];
    const workspaceDir = getAgentDir(agentId);

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
      trustAllTools: agentConfig.trustAllTools,
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
      },
      // M2：上下文预算接 agent 级配置（maxContextTokens），缺省 80000
      contextPipeline: createContextPipelineForAgent(agentConfig),
      // Phase 2：话题压缩配置接 agent 级字段，缺省全开（30 分钟窗 / 20 条阈值 / 主模型压缩）
      topicCompression: {
        ...(agentConfig.compressionModel !== undefined ? { compressionModel: agentConfig.compressionModel } : {}),
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

  async function findProviderConfig(providerId: string | undefined) {
    if (!providerId) return undefined;
    const config = await configRepo.load();
    return config.providers.find((p) => p.id === providerId);
  }

  async function createLLMProvider(agentConfig: AgentConfig) {
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
    return new OpenAIProvider(providerConfig.apiKey, providerConfig.baseUrl, {
      requestTimeout: providerConfig.requestTimeout,
    });
  }

  /** 降级链备用实例：按 providerId 创建；不存在则跳过（返回 undefined），不降级为 ErrorLLMProvider */
  async function createFallbackLLMProvider(
    providerId: string,
    agentConfig: AgentConfig,
  ): Promise<LLMProvider | undefined> {
    if (process.env.NODE_ENV === "e2e") {
      return new MockLLMProvider();
    }
    const providerConfig = await findProviderConfig(providerId);
    if (!providerConfig) {
      logger.warn(`agent '${agentConfig.id}' 的备用 provider '${providerId}' 不存在，跳过`);
      return undefined;
    }
    return new OpenAIProvider(providerConfig.apiKey, providerConfig.baseUrl, {
      requestTimeout: providerConfig.requestTimeout,
    });
  }

  async function createEmbedderProvider(agentConfig: AgentConfig) {
    if (process.env.NODE_ENV === "e2e" || !agentConfig.embedderProviderId) {
      return new MockEmbedderProvider();
    }
    const config = await configRepo.load();
    const providerConfig = config.providers.find((p) => p.id === agentConfig.embedderProviderId);
    if (!providerConfig) {
      return new MockEmbedderProvider();
    }
    return new OpenAIEmbedderProvider(providerConfig.apiKey, providerConfig.baseUrl);
  }

  async function createImageProvider(agentConfig: AgentConfig) {
    if (process.env.NODE_ENV === "e2e" || !agentConfig.imageProviderId) {
      return new MockImageGenProvider();
    }
    const config = await configRepo.load();
    const providerConfig = config.providers.find((p) => p.id === agentConfig.imageProviderId);
    if (!providerConfig) {
      return new MockImageGenProvider();
    }
    return new OpenAIImageGenProvider(providerConfig.apiKey, providerConfig.baseUrl);
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
    mcpManager,
    // P1-3：删除 agent 时经 sidecar DeleteAgent 级联清理向量索引
    sidecarClient,
    skillService,
    puppetModelService,
    intermindService,
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

  // 启动对账（Phase 2 M3）：补归档"已有压缩档但仍留在热存储"的孤儿消息。
  // 在 scheduler/worker 产生新流量前完成；单 agent 失败只记 warn，不阻断启动。
  // ZOME_STARTUP_RECONCILE=false 可关闭（手动管理热存储的场景）。
  if (process.env.ZOME_STARTUP_RECONCILE !== "false") {
    const agents = await agentRepository.list();
    for (const agent of agents) {
      try {
        const repo = new MessageRepository(agent.id);
        const count = await reconcileHotStorage(agent.id, repo);
        if (count > 0) {
          logger.info(`[reconcile] agent=${agent.id} 补归档孤儿消息 ${count} 条`);
        }
        // P1-2：重启孤儿（退出时仍在未关闭话题里的消息）。先查 topic-state.json
        // （廉价文件读），有孤儿才构造 LLM provider 补压缩/归档
        const orphanState = await loadTopicState(agent.id);
        const hasOpen = orphanState?.open && orphanState.open.messageIds.length > 0;
        const hasPending = (orphanState?.pending ?? []).length > 0;
        if (hasOpen || hasPending) {
          const deps = {
            agentId: agent.id,
            // P4 review Minor-2：reconcile 孤儿压缩同样经 record-calls 落档，与主链路一致
            provider: withLLMCallRecording(
              await createLLMProvider(agent),
              new LLMCallRepository(agent.id),
              agent.id,
            ),
            model: agent.compressionModel || agent.modelId || agent.model || "gpt-4o",
            messageRepository: repo,
          };
          // M-b：先补"已关闭已入队未压缩"的 pending 段（desktop /F 主路径缺口）
          if (hasPending) {
            const pendingCount = await reconcilePendingSegments(agent.id, repo, deps);
            if (pendingCount > 0) {
              logger.info(`[reconcile] agent=${agent.id} 补处理 pending 压缩段消息 ${pendingCount} 条`);
            }
          }
          if (hasOpen) {
            const orphanCount = await reconcileOrphanedTopic(agent.id, repo, deps);
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
  try {
    await app.listen({ port, host: "127.0.0.1" });
  } catch (err) {
    // EADDRINUSE 以独立 exit code 2 退出（普通崩溃是 1）：
    // supervisor 据此区分端口冲突与崩溃，不盲目高频重启
    const classified = classifyListenError(err, port);
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
  logger.info(`Engine listening on ${addrStr}`);

  // 优雅关停（P1-2）：SIGTERM/SIGINT 时先 drain 全部 worker 的压缩队列再退出
  // （超时 10s 兜底，不卡死关停）。Windows desktop 的 taskkill /F 强杀不会触发
  // 本 handler——那条路径的重启孤儿由上面的启动对账兜底。
  registerShutdownHandlers({
    drain: async () => {
      await Promise.allSettled([...workerRegistry.all()].map((w) => w.drainCompression()));
    },
    close: async () => {
      scheduler.stop();
      await mcpManager.close();
      await app.close();
    },
    timeoutMs: 10_000,
  });
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});

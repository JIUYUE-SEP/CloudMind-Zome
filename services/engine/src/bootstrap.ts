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
import * as pipelinePlugin from "./plugins/pipeline/index.js";
import * as computePlugin from "./plugins/compute/index.js";
import * as agentsPlugin from "./plugins/agents/index.js";
import { findBuiltinSkillsDir } from "./plugins/skills/index.js";
import { assertServices } from "./plugins/require-services.js";
import { MessageRepository } from "./memory/repositories/message.js";
import { MemoryRepository } from "./memory/repositories/memory.js";
import { ActionRepository } from "./memory/repositories/action.js";
import { LLMCallRepository } from "./memory/repositories/llm-call.js";
import { SessionRepository } from "./conductor/repository.js";
import { ResilientLLMProvider } from "./provider/resilient.js";
import type { LLMProvider } from "./provider/types.js";
import type { ApiContext } from "./api/context.js";
import type { ChatMessage, ProviderConfig } from "@mindcloud/shared";
import { getAgentDir, getDataDir } from "./config/paths.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { BlueprintRepository } from "./blueprint/repository.js";
import { loadSkills } from "./skills/loader.js";
import { SidecarClient } from "./sidecar/client.js";
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
  // pipeline/compute（P5）：均不依赖 memory/mind（pipeline 无依赖；compute 只
  // inject config 已就位）——worker 创建链的两个工厂面，挂在使用点之前即可
  await root.plugin(pipelinePlugin);
  await root.plugin(computePlugin);
  const configRepo = root.config;
  // agentRepository 实例改经 ctx.memory 取（P4 起；P6 起 agents 插件与
  // WorkerRegistry 合体收编进 ctx.agents，onChange→retire 接线在插件内部）
  const agentRepository = root.memory.agentRepository;

  const sidecarClient = new SidecarClient();

  // skills 插件（P3）：getAgentConfig 依赖 agentRepository（P4/P6 才插件化）——
  // 批准的过渡形态：经插件 config 回调进场，后续期换位 inject
  await root.plugin(skillsPlugin, { getAgentConfig: (agentId) => agentRepository.get(agentId) });

  // agents 插件（P6 主峰）：worker 创建链收编。P7 模块与 sidecar 经 config 回调
  // 进场——回调在首个 worker 创建时才被调用（闭包延迟求值），此处 subagentDispatcher
  // 等尚未声明是安全的（TDZ 不会被触发：apply 不急切调用，见 plugins/agents 头注）
  await root.plugin(agentsPlugin, {
    getSubagentServices: () => ({
      subagentDispatcher,
      subagentSwarm,
      puppetModelService,
      intermindService,
    }),
    getSidecar: () => sidecarClient,
  });

  // fail-fast 断言（P3 任务 0）：cordis 对 PENDING 纤维的 await plugin() 立即落定
  // （promise 兑现 ≠ 激活）——挂载完成即断言就位，缺失启动即炸，不带病进运行时。
  // 维护责任：每期插件化新服务后，把自己那行加进下面列表。
  assertServices(root, ["log", "config", "llm", "tools", "skills", "memory", "mind", "pipeline", "compute", "agents"]);

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
    getAgentWorker: (agentId) => root.agents.getOrCreateWorker(agentId),
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
    const worker = await root.agents.getOrCreateWorker(agentId);
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
        compute: root.compute,
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
        getWorker: root.agents.getOrCreateWorker,
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

  // worker 创建链已收编进 agents 插件（P6：plugins/agents/index.ts）；
  // 下方 getOrCreateWorker 调用点全部改经 ctx.agents 取。

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: configRepo,
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: root.agents.getOrCreateWorker,
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
    compute: root.compute,
    retireAgentWorker: (agentId) => root.agents.retire(agentId),
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
      await Promise.allSettled([...root.agents.workerRegistry.all()].map((w) => w.drainCompression()));
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

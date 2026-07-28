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
import { OpenAIEmbedderProvider, MockEmbedderProvider } from "./provider/embedder.js";
import { OpenAIImageGenProvider, MockImageGenProvider } from "./provider/image-gen.js";
import { AgentWorker } from "./core/agent-worker.js";
import { createContextPipelineForAgent } from "./core/pipeline-factory.js";
import { getBuiltinTools } from "./tools/builtin/index.js";
import type { ApiContext } from "./api/context.js";
import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import { getAgentDir, getDataDir } from "./config/paths.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { BlueprintRepository } from "./blueprint/repository.js";
import { loadSkills } from "./skills/loader.js";
import { SidecarClient } from "./sidecar/client.js";
import { MemoryIndexer } from "./memory/indexer.js";
import { reconcileHotStorage, reconcileOrphanedTopic, reconcilePendingSegments } from "./memory/reconcile.js";
import { loadTopicState } from "./memory/topic/state.js";
import { registerShutdownHandlers } from "./shutdown.js";
import { PlanManager } from "./plan/manager.js";
import { SubagentDispatcher } from "./subagent/dispatcher.js";
import { BackgroundManager } from "./subagent/background.js";
import { WorkerRegistry } from "./core/worker-registry.js";
import { withLLMCallRecording } from "./provider/record-calls.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAuthToken, getAuthTokenFilePath } from "./config/auth-token.js";
import { classifyListenError } from "./api/listen-error.js";

/** 从 cwd 向上找 monorepo 根下的 packages/skills（内置技能目录） */
async function findBuiltinSkillsDir(): Promise<string | undefined> {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "packages", "skills");
    const ok = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (ok) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** 解析 Agent 配置的 skill 名称列表为可注入 prompt 的 SKILL.md 内容 */
async function resolveAgentSkillPrompts(agentConfig: AgentConfig): Promise<string[]> {
  const names = agentConfig.skills ?? [];
  if (names.length === 0) return [];
  const dirs: string[] = [];
  const builtin = await findBuiltinSkillsDir();
  if (builtin) dirs.push(builtin);
  dirs.push(path.join(getDataDir(), "skills"));
  dirs.push(path.join(getAgentDir(agentConfig.id), "skills"));
  const skills = await loadSkills({ builtinDirs: dirs });
  const byName = new Map(skills.map((s) => [s.name, s]));
  return names
    .map((n) => byName.get(n)?.content)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
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

  const backgroundManager = new BackgroundManager({ runAgent: runAgentCollect });
  const subagentDispatcher = new SubagentDispatcher({
    getAgentConfig: (agentId) => agentRepository.get(agentId),
    runAgent: runAgentCollect,
    background: backgroundManager,
  });

  const planManagers = new Map<string, PlanManager>();
  async function getPlanManager(agentId: string): Promise<PlanManager | undefined> {
    const existing = planManagers.get(agentId);
    if (existing) return existing;
    const agentConfig = await agentRepository.get(agentId);
    if (!agentConfig) return undefined;
    const manager = new PlanManager({
      provider: await createLLMProvider(agentConfig),
      model: agentConfig.modelId || agentConfig.model || "gpt-4o",
    });
    planManagers.set(agentId, manager);
    return manager;
  }

  async function getOrCreateWorker(agentId: string): Promise<AgentWorker | undefined> {
    return workerRegistry.getOrCreate(agentId, async () => {
      const agentConfig = await agentRepository.get(agentId);
      if (!agentConfig) return undefined;

      const provider = withLLMCallRecording(
        await createLLMProvider(agentConfig),
        new LLMCallRepository(agentId),
        agentId,
      );
      const embedder = await createEmbedderProvider(agentConfig);
    const imageProvider = await createImageProvider(agentConfig);
    const tools = getBuiltinTools().filter((t) => resolveConfiguredTools(agentConfig).includes(t.name));
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
      skillPrompts: await resolveAgentSkillPrompts(agentConfig),
      memoryIndexer,
      embedder,
      imageProvider,
      services: { subagentDispatcher },
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

  async function createLLMProvider(agentConfig: AgentConfig) {
    if (process.env.NODE_ENV === "e2e") {
      return new MockLLMProvider();
    }
    if (!agentConfig.providerId) {
      return new ErrorLLMProvider(
        "尚未配置算力 Provider。请先在「算力平台」添加 Provider，再在本心智的设置中选择它。"
      );
    }
    const config = await configRepo.load();
    const providerConfig = config.providers.find((p) => p.id === agentConfig.providerId);
    if (!providerConfig) {
      logger.warn(
        `agent '${agentConfig.id}' references missing provider '${agentConfig.providerId}'`
      );
      return new ErrorLLMProvider(
        `配置的 Provider「${agentConfig.providerId}」不存在（可能已被删除），请在本心智的设置中重新选择。`
      );
    }
    return new OpenAIProvider(providerConfig.apiKey, providerConfig.baseUrl);
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
    // P1-3：删除 agent 时经 sidecar DeleteAgent 级联清理向量索引
    sidecarClient,
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
  const port = Number(process.env.PORT || 8848);
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
      await app.close();
    },
    timeoutMs: 10_000,
  });
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});

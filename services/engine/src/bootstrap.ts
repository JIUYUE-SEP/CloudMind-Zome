import { createServer } from "./api/server.js";
import { AgentRepository } from "./memory/repositories/agent.js";
import { MessageRepository } from "./memory/repositories/message.js";
import { MemoryRepository } from "./memory/repositories/memory.js";
import { ActionRepository } from "./memory/repositories/action.js";
import { LLMCallRepository } from "./memory/repositories/llm-call.js";
import { ConfigRepository } from "./config/repository.js";
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
import { PlanManager } from "./plan/manager.js";
import { SubagentDispatcher } from "./subagent/dispatcher.js";
import { BackgroundManager } from "./subagent/background.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  const workers = new Map<string, AgentWorker>();

  agentRepository.onChange = (agentId: string, _config: AgentConfig | null) => {
    void _config;
    const worker = workers.get(agentId);
    if (worker) {
      worker.pause();
      workers.delete(agentId);
    }
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
    const existing = workers.get(agentId);
    if (existing) return existing;

    const agentConfig = await agentRepository.get(agentId);
    if (!agentConfig) return undefined;

    const provider = await createLLMProvider(agentConfig);
    const embedder = await createEmbedderProvider(agentConfig);
    const imageProvider = await createImageProvider(agentConfig);
    const tools = getBuiltinTools().filter((t) => agentConfig.tools.includes(t.name));
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
    });
    workers.set(agentId, worker);
    return worker;
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
      console.warn(
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
  scheduler.start();

  const app = await createServer(context);
  await app.listen({ port: Number(process.env.PORT || 8848), host: "127.0.0.1" });
  const addr = app.server.address();
  const addrStr =
    typeof addr === "string"
      ? addr
      : addr
        ? `${addr.address}:${addr.port}`
        : "unknown";
  console.log(`Engine listening on ${addrStr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

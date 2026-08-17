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
import * as conductorPlugin from "./plugins/conductor/index.js";
import * as blueprintPlugin from "./plugins/blueprint/index.js";
import * as handoffPlugin from "./plugins/handoff/index.js";
import * as schedulerPlugin from "./plugins/scheduler/index.js";
import * as plansPlugin from "./plugins/plans/index.js";
import * as intermindPlugin from "./plugins/intermind/index.js";
import * as subagentsPlugin from "./plugins/subagents/index.js";
import { findBuiltinSkillsDir } from "./plugins/skills/index.js";
import { assertServices } from "./plugins/require-services.js";
import { MessageRepository } from "./memory/repositories/message.js";
import { MemoryRepository } from "./memory/repositories/memory.js";
import { ActionRepository } from "./memory/repositories/action.js";
import { LLMCallRepository } from "./memory/repositories/llm-call.js";
import type { ApiContext } from "./api/context.js";
import { getDataDir } from "./config/paths.js";
import { loadSkills } from "./skills/loader.js";
import { SidecarClient } from "./sidecar/client.js";
import { loadTopicState } from "./memory/topic/state.js";
import { registerShutdownHandlers } from "./shutdown.js";
import { withLLMCallRecording } from "./plugins/llm/record-calls.js";
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
  // conductor/blueprint（P7a）：两个仓库单例换源上架；inject 皆空
  // （conductor 路由纯函数与 executeBlueprint 保持库级直 import，不进插件面）
  await root.plugin(conductorPlugin);
  await root.plugin(blueprintPlugin);
  // handoff（P7b）：换班控制面三件套 + WS 续跑循环连接桥收编；manager.load()
  // 启动对账在插件 apply 内完成（listen 前对账时序不变，P3 tools connectAll 同款先例）
  await root.plugin(handoffPlugin);
  const configRepo = root.config;
  // agentRepository 实例改经 ctx.memory 取（P4 起；P6 起 agents 插件与
  // WorkerRegistry 合体收编进 ctx.agents，onChange→retire 接线在插件内部）
  const agentRepository = root.memory.agentRepository;

  const sidecarClient = new SidecarClient();

  // skills 插件（P3）：getAgentConfig 依赖 agentRepository（P4/P6 才插件化）——
  // 批准的过渡形态：经插件 config 回调进场，后续期换位 inject
  await root.plugin(skillsPlugin, { getAgentConfig: (agentId) => agentRepository.get(agentId) });

  // agents 插件（P6 主峰）：worker 创建链收编。P7 模块与 sidecar 经 config 回调
  // 进场——回调在首个 worker 创建时才被调用（闭包延迟求值），届时下方 intermind/
  // subagents 插件（P7d）已挂载上架，经 root.subagents/root.intermind 取实例
  // （挂载顺序安全，见 plugins/agents 头注）
  await root.plugin(agentsPlugin, {
    getSubagentServices: () => ({
      subagentDispatcher: root.subagents.dispatcher,
      subagentSwarm: root.subagents.swarm,
      puppetModelService: root.subagents.puppetModelService,
      intermindService: root.intermind,
    }),
    getSidecar: () => sidecarClient,
  });

  // scheduler/plans（P7c）：调度器与 per-agent PlanManager 懒创建收编；
  // inject agents（plans 另需 llm）——上方 agents 激活后才激活。
  // scheduler 只构造不 start：start/stop 生命周期仍在下方原位置驱动
  await root.plugin(schedulerPlugin);
  await root.plugin(plansPlugin);

  // intermind/subagents（P7d 收尾）：人形间私信与 subagent 调度链路（含傀儡
  // 执行路径、swarm、型号库）收编；intermind 先挂（subagents inject 它）。
  // backgroundManager.load() 启动对账收进 subagents 插件 apply（listen 前
  // 对账时序不变，handoff P7b 同款先例）；agents 的 services 字典经上方
  // config 回调闭包延迟求值取这里上架的面，环不成立
  await root.plugin(intermindPlugin);
  await root.plugin(subagentsPlugin);

  // fail-fast 断言（P3 任务 0）：cordis 对 PENDING 纤维的 await plugin() 立即落定
  // （promise 兑现 ≠ 激活）——挂载完成即断言就位，缺失启动即炸，不带病进运行时。
  // 维护责任：每期插件化新服务后，把自己那行加进下面列表。
  assertServices(root, ["log", "config", "llm", "tools", "skills", "memory", "mind", "pipeline", "compute", "agents", "conductor", "blueprint", "handoff", "scheduler", "plans", "intermind", "subagents"]);

  // 技能服务实例来自 ctx.skills 插件（P3）；下游引用面（worker services/ApiContext）不变
  const skillService = root.skills;

  // MCP servers 生命周期已收编进 tools 插件（P3）：loadDefault+connectAll 在
  // 插件 apply 内完成（启动时序不变），close 挂插件 disposer（关停钩 dispose 触发）；
  // ApiContext 的 mcpManager 经 root.tools.manager 透传。

  // intermind 服务与 subagent 调度链路（runAgentCollect/puppetRunner/
  // backgroundManager/dispatcher/swarm/puppetModelService）已收编进
  // intermind/subagents 插件（P7d：plugins/intermind、plugins/subagents）；
  // 下方 ApiContext 与 agents config 回调改经 root.intermind/root.subagents 取。

  // 换班移交控制面与续跑循环注册表已收编进 handoff 插件（P7b：
  // plugins/handoff/index.ts）；下方引用改经 root.handoff 取。

  // per-agent PlanManager 懒创建已收编进 plans 插件（P7c：plugins/plans/index.ts）；
  // 下方 ApiContext.getPlanManager 改经 root.plans 取（语义逐字不变）。

  // worker 创建链已收编进 agents 插件（P6：plugins/agents/index.ts）；
  // 下方 getOrCreateWorker 调用点全部改经 ctx.agents 取。

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: configRepo,
    sessionRepository: root.conductor.sessionRepository,
    blueprintRepository: root.blueprint.blueprintRepository,
    getAgentWorker: root.agents.getOrCreateWorker,
    getPlanManager: root.plans.getPlanManager,
    runAgentCollect: root.subagents.runAgentCollect,
    subagentDispatcher: root.subagents.dispatcher,
    backgroundManager: root.subagents.backgroundManager,
    // handoff 三件套实例改经插件面取（P7b 换源；连接桥工厂供 WS 私聊 handler attach）
    handoffManager: root.handoff.manager,
    handoffLoops: root.handoff.loops,
    handoff: root.handoff,
    mcpManager: root.tools.manager,
    // P1-3：删除 agent 时经 sidecar DeleteAgent 级联清理向量索引
    sidecarClient,
    skillService,
    puppetModelService: root.subagents.puppetModelService,
    intermindService: root.intermind,
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

  // Scheduler 实例改经 scheduler 插件构造（P7c：plugins/scheduler/index.ts，
  // 窄依赖 + 5s 轮询选项随构造迁入）；start 仍在下方原位置（启动对账之后、
  // createServer 之前），先后序一字不动。

  // subagent 后台任务启动对账已收进 subagents 插件 apply（P7d）：持久化记录
  // 回填内存索引、running 一律标 lost 在插件挂载时完成，listen 前对账时序不变
  // （handoff P7b 同款先例）。
  // 换班控制面启动对账已收进 handoff 插件 apply（P7b）：活跃续跑条目标 lost
  // 在插件挂载时完成，listen 前对账时序不变。

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

  root.scheduler.start();

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
    // 先停止接收新任务（scheduler 触发的压缩段），再 drain 存量队列
    stop: () => root.scheduler.stop(),
    drain: async () => {
      await Promise.allSettled([...root.agents.workerRegistry.all()].map((w) => w.drainCompression()));
    },
    close: async () => {
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

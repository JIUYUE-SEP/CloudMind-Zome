import { logger } from "./logger.js";
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
import * as perceptionPlugin from "./plugins/perception/index.js";
import * as invariantsPlugin from "./plugins/invariants/index.js";
import * as sidecarPlugin from "./plugins/sidecar/index.js";
import * as httpPlugin from "./plugins/http/index.js";
import * as externalPlugin from "./plugins/external/index.js";
import { assertServices } from "./plugins/require-services.js";
import { registerShutdownHandlers } from "./shutdown.js";

// P9 终态：bootstrap 退役为薄组合根——cordis 树挂载（含三个 config 回调
// 过渡形态：skills.getAgentConfig、agents.getSubagentServices/getSidecar、
// memory.onTopicArchived）→ assertServices fail-fast → engine/ready
// （启动对账 + scheduler start，serial 按注册序）→ http.listen() → 关停钩。
// ApiContext 装配与 listen 段收进 plugins/http；启动对账收进 plugins/memory
// （docs/superpowers/plans/2026-08-14-cordis-plugin-migration.md）
// 迁移第二阶段 E1+E2：external 插件挂全部内部插件之后、assertServices 之前
// （DATA_DIR 外部插件清单驱动进场，见 plugins/external 头注）。

async function main() {
  const root = new Context();
  await root.plugin(logPlugin);
  await root.plugin(configPlugin);
  await root.plugin(llmPlugin);
  // tools（P3）：MCP connectAll 在插件 apply 内完成（启动时序不变）；
  // fiber 引用留给关停钩——close 挂插件 disposer
  const toolsFiber = await root.plugin(toolsPlugin);
  // memory/mind（P4）+ memory/archived 事件通道 config 回调（P8b 过渡形态）。
  // P9：memory inject 追加 llm/mind（启动对账依赖）——本行挂载时 fiber 暂
  // PENDING，下一行 mind 挂载即激活（PENDING 语义替代手工排序；memory 的
  // 全部消费点都在 mind 挂载之后，启动时序不变）
  await root.plugin(memoryPlugin, {
    onTopicArchived: (agentId, ids) => root.serial("memory/archived", { agentId, ids }),
  });
  await root.plugin(mindPlugin);
  // pipeline/compute（P5）：worker 创建链的两个工厂面，挂在使用点之前即可
  await root.plugin(pipelinePlugin);
  await root.plugin(computePlugin);
  // conductor/blueprint（P7a）：两个仓库单例换源上架；inject 皆空
  await root.plugin(conductorPlugin);
  await root.plugin(blueprintPlugin);
  // handoff（P7b）：manager.load() 启动对账在插件 apply 内完成（listen 前时序不变）
  await root.plugin(handoffPlugin);
  // sidecar（P9）：SidecarClient 单例上架（原组合根构造点原位）——消费面 =
  // agents config 回调 getSidecar + http 插件 ApiContext.sidecarClient
  await root.plugin(sidecarPlugin);

  // skills 插件（P3）：getAgentConfig 经 config 回调进场（批准的过渡形态）
  await root.plugin(skillsPlugin, { getAgentConfig: (agentId) => root.memory.agentRepository.get(agentId) });

  // agents 插件（P6 主峰）：P7 模块与 sidecar 经 config 回调进场——闭包延迟
  // 求值，首个 worker 创建时才回调，届时 intermind/subagents（P7d）与
  // sidecar（P9）已挂载上架（挂载顺序安全，见 plugins/agents 头注）
  await root.plugin(agentsPlugin, {
    getSubagentServices: () => ({
      subagentDispatcher: root.subagents.dispatcher,
      subagentSwarm: root.subagents.swarm,
      puppetModelService: root.subagents.puppetModelService,
      intermindService: root.intermind,
    }),
    getSidecar: () => root.sidecar,
  });

  // scheduler/plans（P7c）：inject agents（plans 另需 llm）。P9：scheduler.start()
  // 收进插件内 engine/ready 监听（对账完成才起轮询，见 plugins/scheduler 头注）；
  // stop 面留给下方关停钩
  await root.plugin(schedulerPlugin);
  await root.plugin(plansPlugin);

  // perception（P8a）：感知注入单口总线——先于 intermind/subagents 挂载（两者 inject 它）
  await root.plugin(perceptionPlugin);

  // invariants（P8b）：灵魂断言；摘除本插件即回结构性保证（P8 回退路径）
  await root.plugin(invariantsPlugin);

  // intermind/subagents（P7d 收尾）：intermind 先挂（subagents inject 它）；
  // backgroundManager.load() 启动对账收进 subagents 插件 apply（listen 前时序不变）
  await root.plugin(intermindPlugin);
  await root.plugin(subagentsPlugin);

  // http（P9 收口）：ApiContext 装配与 listen 段收进插件（inject 全消费面，
  // 末位挂载）；fiber 引用留给关停钩——close 挂插件 disposer（tools 同款先例）
  const httpFiber = await root.plugin(httpPlugin);

  // external（迁移第二阶段 E1+E2）：DATA_DIR 外部插件发现/加载——全局 plugins.json
  // + per-agent agents/<id>/plugins.yml 双清单驱动、fail-closed（单个失败 warn
  // 不阻断，见 plugins/external 头注）。位置：全部内部插件挂载之后、assertServices
  // 之前——E2 起 inject=["agents"]（枚举 per-agent 清单）要求挂在 agents 之后，
  // 此位置满足；外部插件 inject 的内部服务已全部就位；下方 serial("engine/ready")
  // 外部插件可监听
  await root.plugin(externalPlugin);

  // fail-fast 断言（P3 任务 0）：cordis 对 PENDING 纤维的 await plugin() 立即落定
  // （promise 兑现 ≠ 激活）——挂载完成即断言就位，缺失启动即炸，不带病进运行时。
  // 维护责任：每期插件化新服务后，把自己那行加进下面列表。
  assertServices(root, ["log", "config", "llm", "tools", "skills", "memory", "mind", "pipeline", "compute", "agents", "conductor", "blueprint", "handoff", "scheduler", "plans", "intermind", "subagents", "perception", "invariants", "sidecar", "http", "external"]);

  // engine/ready（P9）：serial 派发一次——监听按注册序执行（激活序 memory →
  // scheduler）：memory 启动对账先落定，scheduler.start() 后起轮询；即原
  // 「启动对账 → scheduler.start() → createServer」先后序的事件化表达
  await root.serial("engine/ready");

  // listen 段全部语义（createServer → token 就绪 → EADDRINUSE exit 2 →
  // banner）收在 http 插件 listen() 面内，逐字保留
  await root.http.listen();

  // 优雅关停（P1-2）：SIGTERM/SIGINT 时先 drain 全部 worker 的压缩队列再退出
  // （超时 10s 兜底，不卡死关停）。Windows desktop 的 taskkill /F 强杀不会触发
  // 本 handler——那条路径的重启孤儿由启动对账兜底（P9 起在 memory 插件，
  // engine/ready 驱动）。
  registerShutdownHandlers({
    // 先停止接收新任务（scheduler 触发的压缩段），再 drain 存量队列
    stop: () => root.scheduler.stop(),
    drain: async () => {
      await Promise.allSettled([...root.agents.workerRegistry.all()].map((w) => w.drainCompression()));
    },
    close: async () => {
      // 只许 dispose 子 fiber——根 fiber dispose = restart（P3 实证），严禁碰 root。
      // MCP close 挂 tools 插件 disposer；app.close() 挂 http 插件 disposer
      await toolsFiber.dispose();
      await httpFiber.dispose();
    },
    timeoutMs: 10_000,
  });
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});

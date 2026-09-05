import path from "node:path";
import fs from "node:fs/promises";
import type { Context } from "cordis";
import { logger } from "../../logger.js";
import { createServer } from "../../api/server.js";
import type { ApiContext } from "../../api/context.js";
import { MessageRepository } from "../../memory/repositories/message.js";
import { MemoryRepository } from "../../memory/repositories/memory.js";
import { ActionRepository } from "../../memory/repositories/action.js";
import { LLMCallRepository } from "../../memory/repositories/llm-call.js";
import { withLLMCallRecording } from "../llm/record-calls.js";
import { ToolBlurbStore } from "../../core/tool-blurb-store.js";
import { ToolCatalogService } from "../../core/tool-catalog-service.js";
import { getDataDir } from "../../config/paths.js";
import { loadSkills } from "../../skills/loader.js";
import { findBuiltinSkillsDir } from "../skills/index.js";
import { getAuthToken, getAuthTokenFilePath } from "../../config/auth-token.js";
import { classifyListenError } from "../../api/listen-error.js";
import { getGitShortHash } from "../../git-commit.js";
import { flushStdout } from "../../flush-stdout.js";
import { DEFAULT_ENGINE_PORT } from "@cloudmind/shared";

/**
 * http 插件（P9 收口主力）：HTTP 服务面上架 ctx.http，bootstrap 退役为薄组合根。
 *
 * - ApiContext 装配自 bootstrap.ts 逐字迁入（字段来源 root.* → ctx.*，
 *   含 listSkills 闭包与 findBuiltinSkillsDir/loadSkills 库级 import 随迁）；
 *   api/context.ts 接口不动，保留为路由面向契约——16 个路由与 2 个
 *   WS handler 零改动。
 * - listen() 面封装原 bootstrap listen 段全部语义：先 createServer，
 *   再 await getAuthToken()（listen 前 token 就绪竞态注释逐字保留）、
 *   CLOUDMIND_AUTH_TOKEN 未设提示日志、PORT/env 解析、
 *   app.listen({ port, host: "127.0.0.1" })、EADDRINUSE 经
 *   classifyListenError 以 exit code 2 退出、启动 banner（git 短哈希可选）、
 *   listen 成功后落 engine.pid（H9，供 sidecar 收编击杀）。
 *   组合根只调一次；重复调用防御性报错。
 * - app.close() 挂本插件 fiber 的 effect disposer（P3 tools 同款先例）：
 *   bootstrap 关停钩 dispose 本 fiber 即触发——只许 dispose 子 fiber，
 *   根 fiber dispose = restart（P3 实证），严禁碰 root。disposer 同时
 *   best-effort 清理 engine.pid（仅当内容仍是本进程 pid）。
 */
export const name = "http";

/** ApiContext 装配实际取用的全部 ctx 服务（宁全勿漏，见头注） */
export const inject = [
  "agents",
  "memory",
  "conductor",
  "blueprint",
  "plans",
  "subagents",
  "handoff",
  "intermind",
  "skills",
  "tools",
  "mind",
  "compute",
  "config",
  "sidecar",
  // v3 blurb 管理面：regenerate 走 agent provider 链（ctx.llm.createProvider）
  "llm",
  // F1：/plugins 路由读 ctx.external——cordis 对未 inject 的服务访问即抛
  // （"cannot get property without inject"，已 provide 也一样）。inject 后
  // http 纤维在 bootstrap 挂载位（external 之前）停 PENDING，external 上架
  // 才激活——external inject=["agents"] 与 http 无环，激活顺延由 cordis 保证
  // （assertServices 兜底 fail-fast）；代价是外部插件 inject "http" 会被记
  // pending（http 面是组合根专用，外部插件无正当消费场景，如实记录）
  "external",
];

/** ctx.http 上架面 */
export interface HttpFace {
  /** 启动 HTTP 服务（组合根只调一次；内部完成 createServer 与 token 就绪） */
  listen(): Promise<void>;
}

declare module "cordis" {
  interface Context {
    /** HTTP 服务面（见 HttpFace） */
    http: HttpFace;
  }
}

export function apply(ctx: Context): void {
  // ApiContext 装配（bootstrap.ts 逐字迁入，字段来源 root.* → ctx.*）
  const context: ApiContext = {
    agentRepository: ctx.memory.agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: ctx.config,
    sessionRepository: ctx.conductor.sessionRepository,
    blueprintRepository: ctx.blueprint.blueprintRepository,
    getAgentWorker: ctx.agents.getOrCreateWorker,
    getPlanManager: ctx.plans.getPlanManager,
    // F6：agent 删除时逐出 plans 缓存（路由 DELETE 经此调用，见 plugins/plans 头注）
    evictPlanManager: (agentId) => ctx.plans.evict(agentId),
    runAgentCollect: ctx.subagents.runAgentCollect,
    subagentDispatcher: ctx.subagents.dispatcher,
    backgroundManager: ctx.subagents.backgroundManager,
    // handoff 三件套实例经插件面取（P7b 换源；连接桥工厂供 WS 私聊 handler attach）
    handoffManager: ctx.handoff.manager,
    handoffLoops: ctx.handoff.loops,
    handoff: ctx.handoff,
    mcpManager: ctx.tools.manager,
    // P1-3：删除 agent 时经 sidecar DeleteAgent 级联清理向量索引
    sidecarClient: ctx.sidecar,
    skillService: ctx.skills,
    puppetModelService: ctx.subagents.puppetModelService,
    intermindService: ctx.intermind,
    mind: ctx.mind,
    compute: ctx.compute,
    // F1：inject 已声明 external（见 inject 列表注），装配执行时面必就位
    external: ctx.external,
    // v3 blurb 管理面（tool-catalog 三端点）：store 与 agents 插件同路径实例——
    // DocumentStore 写队列/读缓存按文件路径模块级串行，双实例等价单写者；
    // regenerate 的 provider 经 record 包装落 llm_calls 账（spec 决策 5）
    toolCatalog: new ToolCatalogService({
      store: new ToolBlurbStore(),
      toolsForAgent: (agentConfig) => ctx.tools.forAgent(agentConfig),
      listSkills: (agentId) => ctx.skills.list(agentId),
      listAgents: () => ctx.memory.agentRepository.list(),
      createProvider: async (agentId, agentConfig) => {
        const providerConfig = await ctx.llm.findProviderConfig(agentConfig.providerId);
        return withLLMCallRecording(await ctx.llm.createProvider(agentConfig), new LLMCallRepository(agentId), agentId, {
          providerId: providerConfig?.id,
          providerName: providerConfig?.displayName ?? providerConfig?.id,
        });
      },
      modelOf: (agentConfig) => agentConfig.modelId || agentConfig.model || "gpt-4o",
    }),
    retireAgentWorker: (agentId) => ctx.agents.retire(agentId),
    // P4-d：topics restore 的重索引钩子——压缩归档时 M14 已 tombstone 向量，
    // 恢复后经 worker 的索引器重新 embed upsert（无索引器/语义检索关闭时
    // worker 内静默跳过）。fire-and-forget：embed 是慢操作，不阻断 restore
    // 响应；worker 创建/索引失败仅 warn（恢复本体已成功，向量下一轮可由
    // 新消息索引自然覆盖，残留不可检索代价与索引失败降级口径一致）
    reindexMessages: (agentId, records) => {
      void ctx.agents
        .getOrCreateWorker(agentId)
        .then((worker) => worker?.reindexMessages(records))
        .catch((err) => {
          logger.warn({ err: err }, "[http] 恢复消息重索引失败（已跳过，不影响恢复结果）");
        });
    },
    listSkills: async () => {
      const dirs: string[] = [];
      const builtin = await findBuiltinSkillsDir();
      if (builtin) dirs.push(builtin);
      dirs.push(path.join(getDataDir(), "skills"));
      const skills = await loadSkills({ builtinDirs: dirs });
      return skills.map((s) => ({ name: s.name, description: s.description, version: s.version }));
    },
  };

  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  let listenCalled = false;

  async function listen(): Promise<void> {
    // 组合根契约：只调一次（现状语义）；重复调用是接线 bug，防御性报错
    if (listenCalled) {
      throw new Error("[http] listen() 重复调用：组合根只应在 engine/ready 后调用一次");
    }
    listenCalled = true;
    app = await createServer(context);
    // 在 listen 前确保 token 已就绪/落盘：web 开发通道（/api/engine-token）
    // 在请求时读 auth-token 文件，晚于 listen 生成会引入竞态
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
        // M51：exit 前等 stdout 已缓冲日志冲刷完毕（范式与超时兜底见
        // flush-stdout.ts）——否则本条端口冲突日志（supervisor 排障关键证据）
        // 在 POSIX 管道下可能被截断
        await flushStdout();
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
    // H9：listen 成功后落 pidfile——sidecar 收编（adopt）本进程时凭它在校验
    // 身份后击杀，闭合 restart 恢复闭环。必须在 listen 成功之后写：
    // EADDRINUSE 退出时覆写健康 engine 的 pidfile 会让 sidecar 杀错目标。
    // 失败不阻断：sidecar 按无 pid 处理（旧语义：只监控不击杀）
    try {
      await fs.writeFile(path.join(getDataDir(), "engine.pid"), String(process.pid), {
        mode: 0o600,
      });
    } catch (err) {
      logger.warn(
        `[http] engine.pid 落盘失败，sidecar 收编将不可击杀：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // S1：启动 banner 带 git 短哈希（代码版本），无 git 时省略该字段不崩
    logger.info(
      {
        addr: addrStr,
        ...(gitCommit !== undefined ? { gitCommit } : {}),
      },
      `Engine listening on ${addrStr}${gitCommit !== undefined ? ` (git ${gitCommit})` : ""}`,
    );
  }

  ctx.provide("http", { listen } satisfies HttpFace);
  // close 挂 fiber effect：关停钩 dispose 本插件 fiber 时执行（P3 tools 同款先例）；
  // listen 从未被调用（测试挂载场景）时 app 为 undefined，空转不炸
  ctx.effect(() => async () => {
    await app?.close();
    // H9 pidfile 清理：只在内容仍是本进程 pid 时删除（防误删后继 engine 的
    // pidfile）；best-effort——ENOENT/IO 错误一律忽略，不阻断关停
    try {
      const pidFile = path.join(getDataDir(), "engine.pid");
      const content = await fs.readFile(pidFile, "utf-8");
      if (content.trim() === String(process.pid)) {
        await fs.rm(pidFile, { force: true });
      }
    } catch {
      /* best-effort */
    }
  });
}

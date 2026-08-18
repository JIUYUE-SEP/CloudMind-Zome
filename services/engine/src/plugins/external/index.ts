import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load as loadYaml } from "js-yaml";
import type { Context, Plugin } from "cordis";
import { logger } from "../../logger.js";
import { getAgentDir, getDataDir } from "../../config/paths.js";

/**
 * external 插件（迁移第二阶段 E1+E2）：外部插件发现/加载。
 *
 * - 居住地：`DATA_DIR/plugins/<name>/index.mjs`——纯 JS ESM，与内部插件
 *   同构四件套（name/inject/apply），动态 import 的模块命名空间直接喂
 *   ctx.plugin() 挂载。
 * - 全局清单 `DATA_DIR/plugins.json`（E1）：
 *   `{ "plugins": { "<name>": { "enabled": true, "config": {...} } } }`。
 *   enabled 缺省 true，config 缺省 {}；文件缺失 → 静默空清单；
 *   JSON 解析失败/结构非法 → warn + 空清单。
 * - per-agent 器官清单 `DATA_DIR/agents/<id>/plugins.yml`（E2，与 SOUL.md 同级）：
 *   ```yaml
 *   plugins:
 *     hello:
 *       enabled: true
 *       config:
 *         key: value
 *   ```
 *   缺省同全局（enabled=true、config={}）；文件缺失 → 该 agent 无外部插件
 *   （静默）；YAML 损坏 → warn + 该 agent 跳过。boot 时经 agentRepository.list()
 *   枚举 agent，按 (agent × plugin) 对挂载，config = { ...manifestConfig, agentId }
 *   （插件自知服务谁，事件载荷 agentId 自行过滤）。新建 agent 的外部插件
 *   **重启后生效**——无热重载（决策 5）。
 * - 目录扫描只做存在性枚举，**加载以清单为准**：目录存在但全局清单与各
 *   agent 清单均未登记 → warn 提示，不挂载。
 * - 「校验+加载单插件模块」（loadPluginModule）与「按清单挂载」
 *   （loadFromManifest）拆清，全局/per-agent 两处复用——同一插件可同时被
 *   全局与多个 agent 启用（各自独立挂载、config 不同，属预期）。
 * - fail-closed 不阻断启动：无 index.mjs / 缺 apply / name 非字符串 /
 *   name 与目录名不符 / import 或 apply 抛错 → warn + 跳过，其余照常。
 * - inject 声明了不存在的服务 → fiber 停 PENDING（cordis 原生语义），
 *   全部挂载完成后统一 warn 列出未激活插件名。PENDING 判据是
 *   fiber.state（实证见 tests/plugins/llm.test.ts 钉死的注释：cordis
 *   rc.8 的 await ctx.plugin() 对 PENDING 纤维立即返回，promise 兑现
 *   ≠ 激活）。
 * - 挂载点：bootstrap 全部内部插件挂载之后、assertServices 之前——外部
 *   插件 inject 的内部服务已就位，且能监听随后的 serial("engine/ready")。
 * - 信任模型：用户自装代码，进程内全权限（类 Obsidian），V1 不做沙箱。
 */
export const name = "external";

/**
 * E2：inject agents——per-agent 清单枚举走 ctx.agents.agentRepository.list()。
 * 排序由 bootstrap 挂载位保证（external 挂在 agents 之后，纤维即挂即激活）
 */
export const inject: string[] = ["agents"];

/**
 * 跳过原因（face 观测 + 测试断言用，取值即契约，勿随意改）。
 * loaded/skipped（含 perAgent status）构成划分：激活的记 loaded，
 * 其余一律记 skipped/status=SkipReason 带原因。
 */
export type SkipReason =
  | "disabled" // 清单 enabled:false（用户显式禁用，不 warn）
  | "invalid-entry" // 清单条目不是对象 / 插件名非法（含路径分隔符，防越出 plugins 目录）
  | "missing-entry" // 无 index.mjs
  | "import-failed" // 动态 import 抛错
  | "no-apply" // 模块命名空间缺 apply 函数
  | "invalid-name" // name 导出非字符串
  | "name-mismatch" // name 导出与目录名不符
  | "mount-failed" // ctx.plugin() 同步抛错
  | "apply-failed" // apply 执行抛错（fiber FAILED）
  | "pending"; // inject 依赖未就位，未激活

export interface SkippedPlugin {
  name: string;
  reason: SkipReason;
}

/** (agent × plugin) 挂载结果（E2 face 观测 + 测试断言用，status 取值即契约） */
export interface PerAgentPluginResult {
  agentId: string;
  name: string;
  status: "loaded" | SkipReason;
}

/** ctx.external 上架面（可观测性 + 测试断言） */
export interface ExternalFace {
  /** 已成功激活的外部插件名（全局清单顺序，E1） */
  loaded: string[];
  /** 未挂载/未激活的外部插件及原因（全局清单，与 loaded 构成划分，E1） */
  skipped: SkippedPlugin[];
  /** per-agent 清单逐 (agent × plugin) 结果（agent 枚举序 × 各清单序，E2） */
  perAgent: PerAgentPluginResult[];
}

declare module "cordis" {
  interface Context {
    /** 外部插件加载结果（见 ExternalFace） */
    external: ExternalFace;
  }
}

/** 清单条目（plugins.json / plugins.yml 的 plugins.<name> 值） */
interface ManifestEntry {
  enabled?: boolean;
  config?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 读全局清单：文件缺失/不可读 → 静默空清单；JSON 解析失败或结构非法 → warn + 空清单 */
async function readManifest(manifestPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    // 设计定案：文件缺失 → 静默空清单（不可读同样按缺失处理，不 warn）
    return {};
  }
  try {
    const plugins = (JSON.parse(raw) as { plugins?: unknown } | null)?.plugins;
    if (plugins === undefined) return {}; // 合法 JSON 但无 plugins 字段 = 空清单
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
      throw new Error("plugins 字段不是对象");
    }
    return plugins as Record<string, unknown>;
  } catch (err) {
    logger.warn(`[external] plugins.json 解析失败，按空清单处理：${errorMessage(err)}`);
    return {};
  }
}

/**
 * 读 per-agent 器官清单（E2，DATA_DIR/agents/<id>/plugins.yml）：
 * 文件缺失/不可读 → 静默空清单（该 agent 无外部插件）；
 * YAML 解析失败或结构非法（plugins 字段非对象）→ warn + 空清单（该 agent 跳过）。
 */
async function readAgentManifest(agentDir: string, agentId: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(agentDir, "plugins.yml"), "utf-8");
  } catch {
    // 设计定案：文件缺失 → 静默空清单（不可读同样按缺失处理，不 warn）
    return {};
  }
  try {
    // 剥 UTF-8 BOM（skills/loader.ts 同款先例：Windows 记事本存的文件常带 BOM）
    const plugins = (loadYaml(raw.replace(/^\uFEFF/, "")) as { plugins?: unknown } | null)?.plugins;
    if (plugins === undefined) return {}; // 合法 YAML 但无 plugins 字段 = 空清单
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
      throw new Error("plugins 字段不是对象");
    }
    return plugins as Record<string, unknown>;
  } catch (err) {
    logger.warn(`[external] agent ${agentId} 的 plugins.yml 解析失败，该 agent 跳过外部插件：${errorMessage(err)}`);
    return {};
  }
}

/** 枚举 DATA_DIR/plugins 下的插件目录名（只做存在性枚举，加载以清单为准） */
async function scanPluginDirs(pluginsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // 目录缺失/不可读 → 空扫描
    return [];
  }
}

/**
 * 校验+加载单插件模块（E2 拆出，全局/per-agent 两处复用）：
 * 插件名即目录名（禁路径分隔符，防越出 plugins 目录）；无 index.mjs /
 * import 抛错 / 四件套校验（apply 函数、name 字符串、name 与目录名一致）
 * 任一不过 → warn + 返回 SkipReason；成功返回模块命名空间（即 Plugin.Object）。
 */
async function loadPluginModule(dataDir: string, entryName: string): Promise<{ ns: Plugin } | { reason: SkipReason }> {
  if (entryName === "." || entryName === ".." || entryName.includes("/") || entryName.includes("\\")) {
    logger.warn(`[external] 插件名 ${entryName} 非法（含路径分隔符），跳过`);
    return { reason: "invalid-entry" };
  }
  const indexPath = path.join(dataDir, "plugins", entryName, "index.mjs");
  try {
    await fs.access(indexPath);
  } catch {
    logger.warn(`[external] 插件 ${entryName} 缺少入口 index.mjs，跳过`);
    return { reason: "missing-entry" };
  }
  let ns: { name?: unknown; apply?: unknown };
  try {
    ns = await import(pathToFileURL(indexPath).href);
  } catch (err) {
    logger.warn(`[external] 插件 ${entryName} import 失败：${errorMessage(err)}，跳过`);
    return { reason: "import-failed" };
  }
  // 四件套校验（fail-closed）：缺 apply / name 非字符串 / name 与目录名不符
  if (typeof ns.apply !== "function") {
    logger.warn(`[external] 插件 ${entryName} 缺少 apply 导出，跳过`);
    return { reason: "no-apply" };
  }
  if (typeof ns.name !== "string") {
    logger.warn(`[external] 插件 ${entryName} 的 name 导出非字符串，跳过`);
    return { reason: "invalid-name" };
  }
  if (ns.name !== entryName) {
    logger.warn(`[external] 插件 ${entryName} 的 name 导出（${ns.name}）与目录名不符，跳过`);
    return { reason: "name-mismatch" };
  }
  return { ns: ns as unknown as Plugin };
}

/** 挂载结果记录口（E2：全局清单记 face.loaded/skipped，per-agent 记 face.perAgent） */
interface ResultSink {
  loaded(name: string): void;
  skipped(name: string, reason: SkipReason): void;
}

/**
 * 按清单逐个校验+挂载（E2 拆出，全局/per-agent 两处复用）：
 * 单条失败 warn 不阻断其余；extraConfig（per-agent 注入的 agentId）合入
 * 插件 config——同一 (agent, plugin) 挂载失败不影响其余对。
 */
async function loadFromManifest(
  ctx: Context,
  dataDir: string,
  manifest: Record<string, unknown>,
  sink: ResultSink,
  extraConfig?: Record<string, unknown>,
): Promise<void> {
  const mounted: { name: string; fiber: ReturnType<Context["plugin"]> }[] = [];
  for (const [entryName, rawEntry] of Object.entries(manifest)) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      logger.warn(`[external] 清单条目 ${entryName} 格式无效（应为对象），跳过`);
      sink.skipped(entryName, "invalid-entry");
      continue;
    }
    const entry = rawEntry as ManifestEntry;
    if (entry.enabled === false) {
      // 用户显式禁用：记 face 不 warn（info 留一行启动可观测性）
      logger.info(`[external] 插件 ${entryName} 在清单中被禁用（enabled:false），跳过`);
      sink.skipped(entryName, "disabled");
      continue;
    }
    const loaded = await loadPluginModule(dataDir, entryName);
    if ("reason" in loaded) {
      sink.skipped(entryName, loaded.reason);
      continue;
    }
    // config 合成：全局 = entry.config ?? {}（原样透传，E1 语义）；per-agent =
    // { ...manifestConfig, ...extraConfig }（agentId 注入，插件自知服务谁）。
    // 非对象 config 无法展开，按 {} 处理
    const config = extraConfig
      ? {
          ...(typeof entry.config === "object" && entry.config !== null && !Array.isArray(entry.config)
            ? entry.config
            : {}),
          ...extraConfig,
        }
      : (entry.config ?? {});
    try {
      // 模块命名空间即 Plugin.Object，config 缺省 {}（设计定案）
      mounted.push({ name: entryName, fiber: ctx.plugin(loaded.ns, config) });
    } catch (err) {
      logger.warn(`[external] 插件 ${entryName} 挂载失败：${errorMessage(err)}，跳过`);
      sink.skipped(entryName, "mount-failed");
    }
  }

  // 统一等全部挂载落定：inject 就位者 await 至 ACTIVE；PENDING 者 await
  // 立即落定（cordis rc.8 实证，见 tests/plugins/llm.test.ts 钉死的注释）——
  // await 返回后 fiber.state !== 2（ACTIVE）即未激活。逐个等（而非
  // Promise.all）保清单顺序，face 输出确定
  const pending: string[] = [];
  for (const { name: pluginName, fiber } of mounted) {
    try {
      await fiber;
    } catch (err) {
      // apply 抛错：fiber FAILED，await 原样抛回（cordis 内部已记 error 日志）
      logger.warn(`[external] 插件 ${pluginName} apply 执行失败：${errorMessage(err)}，跳过`);
      sink.skipped(pluginName, "apply-failed");
      continue;
    }
    if (fiber.state === 2) {
      // ACTIVE（FiberState 是 const enum 无运行时对象，按数值比对）
      sink.loaded(pluginName);
    } else {
      pending.push(pluginName);
      sink.skipped(pluginName, "pending");
    }
  }
  // 统一 warn 列未激活名（不静默）；inject 到齐后 cordis 会自行激活，
  // 但挂载点之后不会再有新内部服务上架，PENDING 即终态
  if (pending.length > 0) {
    logger.warn(`[external] 以下外部插件 inject 依赖未就位，未激活：${pending.join(", ")}`);
  }
}

export async function apply(ctx: Context): Promise<void> {
  // face 先上架（数组在 loadExternal 内就地填充）——保证骨架自身即便中途
  // 异常，ctx.external 也可用，assertServices 不炸启动
  const face: ExternalFace = { loaded: [], skipped: [], perAgent: [] };
  ctx.provide("external", face);
  try {
    await loadExternal(ctx, face);
  } catch (err) {
    // 兜底防御：骨架任何未预期异常都不阻断启动（fail-closed）
    logger.warn(`[external] 外部插件加载骨架异常，已跳过全部外部插件：${errorMessage(err)}`);
  }
}

async function loadExternal(ctx: Context, face: ExternalFace): Promise<void> {
  const dataDir = getDataDir();
  const manifest = await readManifest(path.join(dataDir, "plugins.json"));
  const dirs = await scanPluginDirs(path.join(dataDir, "plugins"));

  // E2 per-agent 清单先枚举（先于孤儿检查：只对 agent 启用的插件也算「已登记」，
  // 否则全局孤儿检查会对合法 per-agent 插件误报未登记）。经 agentRepository.list()
  // 枚举 agent，读各自 plugins.yml；单 agent 坏清单 warn 跳过，不阻断其余 agent
  const agents = await ctx.agents.agentRepository.list();
  const agentManifests: { agentId: string; manifest: Record<string, unknown> }[] = [];
  for (const agent of agents) {
    const agentManifest = await readAgentManifest(getAgentDir(agent.id), agent.id);
    if (Object.keys(agentManifest).length > 0) {
      agentManifests.push({ agentId: agent.id, manifest: agentManifest });
    }
  }

  // 目录存在但全局清单与各 agent 清单均未登记 → warn 提示，不挂载（加载以清单为准）。
  // hasOwn 防 "constructor" 之类的原型键误判为已登记
  for (const dir of dirs) {
    if (!Object.hasOwn(manifest, dir) && !agentManifests.some((a) => Object.hasOwn(a.manifest, dir))) {
      logger.warn(`[external] 插件目录 ${dir} 未登记入任何清单（plugins.json / agents/<id>/plugins.yml），不挂载（要启用请在清单补登记）`);
    }
  }

  // E1 全局清单
  await loadFromManifest(ctx, dataDir, manifest, {
    loaded: (name) => face.loaded.push(name),
    skipped: (name, reason) => face.skipped.push({ name, reason }),
  });

  // E2 per-agent：按 (agent × plugin) 对挂载（config 注入 agentId）。新建 agent 的
  // 外部插件重启后生效——无热重载（决策 5）
  for (const { agentId, manifest: agentManifest } of agentManifests) {
    await loadFromManifest(
      ctx,
      dataDir,
      agentManifest,
      {
        loaded: (name) => face.perAgent.push({ agentId, name, status: "loaded" }),
        skipped: (name, reason) => face.perAgent.push({ agentId, name, status: reason }),
      },
      { agentId },
    );
  }
}

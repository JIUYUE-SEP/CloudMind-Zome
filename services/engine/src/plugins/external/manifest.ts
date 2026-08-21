import fs from "node:fs/promises";
import path from "node:path";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";
import { renameWithRetry } from "../memory/document-store.js";

/**
 * M1：外部插件清单读写面（管理面启用/禁用写操作的存储层）。
 *
 * - 与 loader（external/index.ts）共享清单语义：全局 `DATA_DIR/plugins.json` /
 *   per-agent `DATA_DIR/agents/<id>/plugins.yml`，同形
 *   `{ plugins: { "<name>": { enabled=true, config={} } } }`。
 * - 读：文件缺失 → 空清单；解析失败/结构非法 → ManifestCorruptError（路由映射
 *   409 显式报错）。loader 的「warn + 空清单」是加载期容错，管理写面必须
 *   fail-closed——把损坏文件当空清单再合并写回等于静默覆盖用户数据（H3 绝不覆盖）。
 * - 写：读-改-写在同一队列槽内串行（按文件路径排队），tmp + rename 原子替换；
 *   其他条目、条目内未知字段、plugins 之外的顶层键全部原样保留；
 *   config 更新是整体替换该条目的 config 字段。
 * - 无热重载（决策 5）：写只改清单文件，生效需重启（响应侧带 requiresRestart）。
 */

/** 插件名白名单字符集（与 agent id 同口径：字母/数字/下划线/连字符，天然杜绝路径分隔符与 "." 越界） */
export const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 清单文件损坏（JSON/YAML 解析失败或结构非法）：路由映射 409，不覆盖原文件 */
export class ManifestCorruptError extends Error {}

/** 清单条目的管理面视图（enabled 缺省 true、config 缺省 {}，与 loader 同口径） */
export interface ManifestEntryView {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** 单条写补丁：两字段至少其一（路由侧校验）；config 整体替换该条目原 config */
export interface ManifestPatch {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

type ManifestFormat = "json" | "yaml";
type RawDoc = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 写队列挂在模块级、按文件路径串行（document-store 同款模式）：读-改-写必须在
// 同一槽内完成，并发 PUT 同一清单才不丢更新、tmp 文件不互相踩踏。
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite<T>(filePath: string, op: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(op, op);
  // 队列只承载 settle 信号：前序失败经 next 传给其调用方，不阻断后续排队者
  const tail = next.then(() => undefined, () => undefined);
  writeQueues.set(filePath, tail);
  // 队列尾部 settle 后清理，避免 Map 随文件数无限增长
  const cleanup = () => {
    if (writeQueues.get(filePath) === tail) writeQueues.delete(filePath);
  };
  tail.then(cleanup, cleanup);
  return next;
}

/** 读清单文档：文件缺失/不可读/全空白 → 空文档；解析失败或顶层非对象 → ManifestCorruptError */
async function readDoc(filePath: string, format: ManifestFormat): Promise<RawDoc> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    // 设计定案（与 loader 同）：文件缺失 → 空清单；不可读同样按缺失处理
    return {};
  }
  // 空白文件没有任何条目可丢，按空清单（空串对 JSON 本就不可解析，特判免误报损坏）
  if (raw.trim() === "") return {};
  let doc: unknown;
  try {
    // YAML 侧剥 UTF-8 BOM（loader 同款先例：Windows 记事本存的文件常带 BOM）
    doc = format === "json" ? JSON.parse(raw) : loadYaml(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new ManifestCorruptError(`${filePath} 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || doc === undefined) return {}; // 空 YAML 文档 = 空清单
  if (!isPlainObject(doc)) {
    throw new ManifestCorruptError(`${filePath} 结构非法：顶层不是对象`);
  }
  return doc;
}

/** 取 plugins 字段：缺失 → 空表；非对象（含数组）→ 结构非法（loader 同样按解析失败处理） */
function pluginsField(doc: RawDoc, filePath: string): Record<string, unknown> {
  const plugins = doc.plugins;
  if (plugins === undefined) return {};
  if (!isPlainObject(plugins)) {
    throw new ManifestCorruptError(`${filePath} 结构非法：plugins 字段不是对象`);
  }
  return plugins;
}

/** 条目 → 管理面视图：缺省 enabled=true、config={}（与 loader 同口径）；非对象条目按全缺省列出（已登记是事实） */
function toEntryView(name: string, raw: unknown): ManifestEntryView {
  const entry = isPlainObject(raw) ? raw : {};
  return {
    name,
    enabled: entry.enabled !== false,
    config: isPlainObject(entry.config) ? entry.config : {},
  };
}

/** 序列化回写：JSON 与 document-store 同排版（2 空格缩进 + 尾换行）；YAML 走 js-yaml dump——
 * 已知取舍：dump 会重写排版并丢弃用户手写注释（语义保留），首次 PUT 后 plugins.yml 变规整形态 */
function serialize(doc: RawDoc, format: ManifestFormat): string {
  return format === "json" ? JSON.stringify(doc, null, 2) + "\n" : dumpYaml(doc);
}

/** tmp + rename 原子写（renameWithRetry：Windows 上目标被并发读取占用时短暂退避重试） */
async function writeDocAtomic(filePath: string, doc: RawDoc, format: ManifestFormat): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, serialize(doc, format));
  await renameWithRetry(tmpPath, filePath);
}

/** 目录有 index.mjs 但未登记入**全局**清单（plugins.json）的插件名（字母序——readdir 顺序随文件系统不稳定；扫描只做存在性枚举，加载以清单为准）。
 * 口径注意：loader 的孤儿检查同时认 per-agent 清单（agents/<id>/plugins.yml）——仅在某个 agent 清单登记的插件
 * 在这里仍显示为 unregistered（全局），但不会被 loader warn。即本字段实为「未登记入全局清单」。 */
async function scanUnregisteredDirs(dataDir: string, registered: ReadonlySet<string>): Promise<string[]> {
  let dirs: string[];
  try {
    const entries = await fs.readdir(path.join(dataDir, "plugins"), { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // plugins 目录缺失/不可读 → 无未登记
  }
  const hasEntryFile = await Promise.all(
    dirs.map(async (dir) => {
      try {
        await fs.access(path.join(dataDir, "plugins", dir, "index.mjs"));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return dirs.filter((dir, i) => hasEntryFile[i] && !registered.has(dir)).sort();
}

/**
 * 全局清单全量视图（GET /plugins/manifest）：清单条目（hasEntry 恒 true——
 * 有清单条目）+ 目录有 index.mjs 但未登记的名字（unregistered）。
 * 文件缺失 → 空清单 + 目录全量进 unregistered；文件损坏 → ManifestCorruptError。
 */
export async function readGlobalManifest(
  dataDir: string,
): Promise<{ plugins: (ManifestEntryView & { hasEntry: true })[]; unregistered: string[] }> {
  const filePath = path.join(dataDir, "plugins.json");
  const doc = await readDoc(filePath, "json");
  const manifest = pluginsField(doc, filePath);
  const plugins = Object.entries(manifest).map(([name, raw]) => ({
    ...toEntryView(name, raw),
    hasEntry: true as const,
  }));
  const unregistered = await scanUnregisteredDirs(dataDir, new Set(Object.keys(manifest)));
  return { plugins, unregistered };
}

/** per-agent 清单视图（GET /agents/:id/plugins/manifest）：文件缺失 → 空清单；损坏 → ManifestCorruptError */
export async function readAgentManifest(agentDir: string): Promise<{ plugins: ManifestEntryView[] }> {
  const filePath = path.join(agentDir, "plugins.yml");
  const doc = await readDoc(filePath, "yaml");
  const manifest = pluginsField(doc, filePath);
  return { plugins: Object.entries(manifest).map(([name, raw]) => toEntryView(name, raw)) };
}

/**
 * 单条写（PUT）：读-改-写同槽串行 + tmp/rename 原子替换。未登记 → 创建条目
 * （登记）；已登记 → 合入补丁（不传的字段保留原值）。清单损坏 → ManifestCorruptError，
 * 不写入（原文件不动）。
 */
export async function updateManifestEntry(
  filePath: string,
  format: ManifestFormat,
  name: string,
  patch: ManifestPatch,
): Promise<ManifestEntryView> {
  return enqueueWrite(filePath, async () => {
    const doc = await readDoc(filePath, format);
    const manifest = pluginsField(doc, filePath);
    const current = manifest[name];
    const entry: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    if (patch.config !== undefined) entry.config = patch.config;
    const next: RawDoc = { ...doc, plugins: { ...manifest, [name]: entry } };
    await writeDocAtomic(filePath, next, format);
    return toEntryView(name, entry);
  });
}

/** 插件目录存在性（PUT 前置：白名单字符校验之后查）：DATA_DIR/plugins/<name> 是目录 → true */
export async function pluginDirExists(dataDir: string, name: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dataDir, "plugins", name))).isDirectory();
  } catch {
    return false;
  }
}

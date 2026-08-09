import { logger } from "../logger.js";
import type { ConfigRepository } from "../config/repository.js";

export interface ContextWindowLookup {
  providerId?: string;
  modelId?: string;
}

/** S7：resolveContextWindow 需要的 config 仓库接口（mtime 可选；测试桩可只给 load） */
export type ContextWindowConfigRepository = Pick<ConfigRepository, "load"> & {
  getConfigFileMtime?: () => Promise<number | undefined>;
};

/** G4：同 (providerId, modelId, 原因) 只 warn 一次，防逐回合日志刷屏，且留痕可观测 */
const warnedKeys = new Set<string>();

function warnLookupFallback(lookup: ContextWindowLookup, reason: string, err?: unknown): void {
  const providerId = lookup.providerId ?? "<无>";
  const modelId = lookup.modelId ?? "<无>";
  const key = `${providerId}|${modelId}|${reason}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger.warn(
    {
      providerId: lookup.providerId,
      modelId: lookup.modelId,
      ...(err !== undefined ? { err } : {}),
    },
    `[context-window] ${reason}（provider=${providerId}, model=${modelId}），` +
      "水位 W 与 pipeline 预算按 W 链兜底（agent maxContextTokens → 80_000）",
  );
}

/** S7：W 查找链短缓存条目（按 config 文件 mtime 失效） */
interface WindowCacheEntry {
  mtimeMs: number;
  window: number | undefined;
}

const WINDOW_CACHE_MAX = 128;
const windowCache = new Map<string, WindowCacheEntry>();

/**
 * 水位主裁 W 查找链（改动三）：agent 配置的 providerId + modelId →
 * configRepository.providers → models.find(id) → contextWindow。
 * 查不到/未配置返回 undefined，由调用方按 W 链回退：agent 显式
 * maxContextTokens → 80_000（worker 与 pipeline 同三档；无 agent 值的
 * puppet 等路径直接落 80_000）。
 * core（turn.ts）不依赖 config repository——本 helper 只服务 runTurn 调用方。
 *
 * S7：configRepository.load 每次都是整文件读 + JSON.parse + 解密，而 W 只依赖
 * providers/models 的静态字段；每回合经 getConfigFileMtime 做廉价 stat，mtime
 * 未变直接复用缓存结果（免掉 load/解密），mtime 变化即失效重读——编辑立即生效。
 * 未提供 mtime（测试桩/stat 失败/文件不存在）不缓存，走原路径。
 */
export async function resolveContextWindow(
  configRepository: ContextWindowConfigRepository | undefined,
  lookup: ContextWindowLookup,
): Promise<number | undefined> {
  if (!configRepository || !lookup.providerId || !lookup.modelId) {
    // G4：参数缺失（调用方未接线/agent 未配置 provider）也留痕一次，静默回落变可观测
    warnLookupFallback(lookup, "查找参数缺失（configRepository/providerId/modelId）");
    return undefined;
  }
  const key = `${lookup.providerId}\u0000${lookup.modelId}`;
  const mtimeMs = await configRepository.getConfigFileMtime?.();
  if (mtimeMs !== undefined) {
    const cached = windowCache.get(key);
    if (cached?.mtimeMs === mtimeMs) return cached.window;
  }
  try {
    const config = await configRepository.load();
    const provider = config.providers.find((p) => p.id === lookup.providerId);
    if (!provider) {
      setWindowCache(key, mtimeMs, undefined);
      warnLookupFallback(lookup, "provider 未找到");
      return undefined;
    }
    const model = provider?.models.find((m) => m.id === lookup.modelId);
    if (!model) {
      setWindowCache(key, mtimeMs, undefined);
      warnLookupFallback(lookup, "型号未找到");
      return undefined;
    }
    if (model.contextWindow === undefined) {
      setWindowCache(key, mtimeMs, undefined);
      warnLookupFallback(lookup, "型号未配置 contextWindow");
      return undefined;
    }
    setWindowCache(key, mtimeMs, model.contextWindow);
    return model.contextWindow;
  } catch (err) {
    // 配置读失败不阻断对话：水位按缺省兜底（80_000），warn 并入 warnedKeys
    // 去重（S8，首条带 err 留痕）——不再逐回合刷 warn
    setWindowCache(key, mtimeMs, undefined);
    warnLookupFallback(lookup, "配置读取失败", err);
    return undefined;
  }
}

/** S7：写入 W 缓存（mtime 可用时）；超上限 FIFO 逐出最旧查询 */
function setWindowCache(
  key: string,
  mtimeMs: number | undefined,
  window: number | undefined,
): void {
  if (mtimeMs === undefined) return;
  if (windowCache.size >= WINDOW_CACHE_MAX && !windowCache.has(key)) {
    const oldest = windowCache.keys().next().value;
    if (oldest !== undefined) windowCache.delete(oldest);
  }
  windowCache.set(key, { mtimeMs, window });
}

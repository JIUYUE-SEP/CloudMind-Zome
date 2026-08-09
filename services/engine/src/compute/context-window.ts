import { logger } from "../logger.js";
import type { ConfigRepository } from "../config/repository.js";

export interface ContextWindowLookup {
  providerId?: string;
  modelId?: string;
}

/** G4：同 (providerId, modelId, 原因) 只 warn 一次，防逐回合日志刷屏，且留痕可观测 */
const warnedKeys = new Set<string>();

function warnLookupFallback(lookup: ContextWindowLookup, reason: string): void {
  const providerId = lookup.providerId ?? "<无>";
  const modelId = lookup.modelId ?? "<无>";
  const key = `${providerId}|${modelId}|${reason}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger.warn(
    { providerId: lookup.providerId, modelId: lookup.modelId },
    `[context-window] ${reason}（provider=${providerId}, model=${modelId}），` +
      "水位 W 与 pipeline 预算按 W 链兜底（agent maxContextTokens → 80_000）",
  );
}

/**
 * 水位主裁 W 查找链（改动三）：agent 配置的 providerId + modelId →
 * configRepository.providers → models.find(id) → contextWindow。
 * 查不到/未配置返回 undefined，由调用方按 W 链回退：agent 显式
 * maxContextTokens → 80_000（worker 与 pipeline 同三档；无 agent 值的
 * puppet 等路径直接落 80_000）。
 * core（turn.ts）不依赖 config repository——本 helper 只服务 runTurn 调用方。
 */
export async function resolveContextWindow(
  configRepository: Pick<ConfigRepository, "load"> | undefined,
  lookup: ContextWindowLookup,
): Promise<number | undefined> {
  if (!configRepository || !lookup.providerId || !lookup.modelId) {
    // G4：参数缺失（调用方未接线/agent 未配置 provider）也留痕一次，静默回落变可观测
    warnLookupFallback(lookup, "查找参数缺失（configRepository/providerId/modelId）");
    return undefined;
  }
  try {
    const config = await configRepository.load();
    const provider = config.providers.find((p) => p.id === lookup.providerId);
    if (!provider) {
      warnLookupFallback(lookup, "provider 未找到");
      return undefined;
    }
    const model = provider?.models.find((m) => m.id === lookup.modelId);
    if (!model) {
      warnLookupFallback(lookup, "型号未找到");
      return undefined;
    }
    if (model.contextWindow === undefined) {
      warnLookupFallback(lookup, "型号未配置 contextWindow");
      return undefined;
    }
    return model?.contextWindow;
  } catch (err) {
    // 配置读失败不阻断对话：水位按缺省兜底（80_000），warn 留痕
    logger.warn({ err: err }, "[context-window] 配置读取失败，水位 W 按缺省兜底");
    return undefined;
  }
}

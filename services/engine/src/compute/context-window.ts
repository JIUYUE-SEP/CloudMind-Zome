import { logger } from "../logger.js";
import type { ConfigRepository } from "../config/repository.js";

export interface ContextWindowLookup {
  providerId?: string;
  modelId?: string;
}

/**
 * 水位主裁 W 查找链（改动三）：agent 配置的 providerId + modelId →
 * configRepository.providers → models.find(id) → contextWindow。
 * 查不到/未配置返回 undefined，由调用方落 80_000 缺省（与 pipeline 同值）。
 * core（turn.ts）不依赖 config repository——本 helper 只服务 runTurn 调用方。
 */
export async function resolveContextWindow(
  configRepository: Pick<ConfigRepository, "load"> | undefined,
  lookup: ContextWindowLookup,
): Promise<number | undefined> {
  if (!configRepository || !lookup.providerId || !lookup.modelId) return undefined;
  try {
    const config = await configRepository.load();
    const provider = config.providers.find((p) => p.id === lookup.providerId);
    const model = provider?.models.find((m) => m.id === lookup.modelId);
    return model?.contextWindow;
  } catch (err) {
    // 配置读失败不阻断对话：水位按缺省兜底（80_000），warn 留痕
    logger.warn({ err: err }, "[context-window] 配置读取失败，水位 W 按缺省兜底");
    return undefined;
  }
}

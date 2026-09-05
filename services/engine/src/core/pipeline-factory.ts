import type { AgentConfig } from "@cloudmind/shared";
import { ContextPipeline, type ContextPipelineConfig } from "../context/pipeline.js";

/**
 * 按 agent 配置创建 ContextPipeline（review M2）。
 * 未配置的项回退 DEFAULT_PIPELINE_CONFIG（80000 tokens + 10% reserve）。
 * 注意：不能把 undefined 直接 spread 进 config（会覆盖默认值），逐项判空。
 *
 * G2（双源统一）：contextWindow 由 resolveContextWindow 同一查找链解析后传入——
 * 型号表 contextWindow 优先驱动预算（128K → 115.2K、32K → 28.8K）；
 * 查不到（undefined）时回退 agent 显式 maxContextTokens，再回退 80_000（现状不变）。
 */
export function createContextPipelineForAgent(
  agentConfig: AgentConfig,
  contextWindow?: number,
): ContextPipeline {
  const config: Partial<ContextPipelineConfig> = {};
  if (contextWindow !== undefined) {
    config.maxContextTokens = contextWindow;
  } else if (agentConfig.maxContextTokens !== undefined) {
    config.maxContextTokens = agentConfig.maxContextTokens;
  }
  return new ContextPipeline(config);
}

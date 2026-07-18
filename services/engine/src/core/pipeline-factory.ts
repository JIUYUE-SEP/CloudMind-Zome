import type { AgentConfig } from "@mindcloud/shared";
import { ContextPipeline, type ContextPipelineConfig } from "../context/pipeline.js";

/**
 * 按 agent 配置创建 ContextPipeline（review M2）。
 * 未配置的项回退 DEFAULT_PIPELINE_CONFIG（80000 tokens + 10% reserve）。
 * 注意：不能把 undefined 直接 spread 进 config（会覆盖默认值），逐项判空。
 */
export function createContextPipelineForAgent(agentConfig: AgentConfig): ContextPipeline {
  const config: Partial<ContextPipelineConfig> = {};
  if (agentConfig.maxContextTokens !== undefined) {
    config.maxContextTokens = agentConfig.maxContextTokens;
  }
  return new ContextPipeline(config);
}

import { describe, it, expect } from "vitest";
import type { AgentConfig } from "@mindcloud/shared";
import { createContextPipelineForAgent } from "../../src/core/pipeline-factory.js";

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "a1",
    name: "小云",
    persona: "",
    skills: [],
    tools: [],
    ...overrides,
  };
}

describe("createContextPipelineForAgent（M2：预算接配置）", () => {
  it("未配置 maxContextTokens：回退默认 80000 × 0.9 = 72000", () => {
    const pipeline = createContextPipelineForAgent(agentConfig());
    expect(pipeline.budgetTokens).toBe(72000);
  });

  it("配置 maxContextTokens=32000：预算 32000 × 0.9 = 28800", () => {
    const pipeline = createContextPipelineForAgent(agentConfig({ maxContextTokens: 32000 }));
    expect(pipeline.budgetTokens).toBe(28800);
  });

  it("maxContextTokens 为 0 时也按配置生效（不被误判为未配置）", () => {
    const pipeline = createContextPipelineForAgent(agentConfig({ maxContextTokens: 0 }));
    expect(pipeline.budgetTokens).toBe(0);
  });
});

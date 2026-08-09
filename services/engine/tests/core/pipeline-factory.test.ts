import { describe, it, expect } from "vitest";
import type { AgentConfig } from "@mindcloud/shared";
import { createContextPipelineForAgent } from "../../src/core/pipeline-factory.js";
import { resolveContextWindow } from "../../src/compute/context-window.js";
import type { ConfigRepository, GlobalConfig } from "../../src/config/repository.js";
import type { ProviderConfig } from "@mindcloud/shared";

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

describe("createContextPipelineForAgent（G2：W 驱动预算，双源统一）", () => {
  function fakeRepo(providers: ProviderConfig[]): Pick<ConfigRepository, "load"> {
    const config: GlobalConfig = {
      providers,
      settings: {
        memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
      },
    };
    return { load: async () => config };
  }

  function provider(id: string, models: ProviderConfig["models"]): ProviderConfig {
    return {
      id,
      displayName: id,
      providerType: "openai",
      baseUrl: "http://localhost",
      models,
    };
  }

  function model(id: string, contextWindow?: number): ProviderConfig["models"][number] {
    return { id, displayName: id, modelType: "llm", contextWindow };
  }

  it("型号表 128K：W 驱动预算 128000 × 0.9 = 115200", async () => {
    const w = await resolveContextWindow(
      fakeRepo([provider("gp1", [model("gm128", 128_000)])]),
      { providerId: "gp1", modelId: "gm128" },
    );
    expect(w).toBe(128_000);
    expect(createContextPipelineForAgent(agentConfig(), w).budgetTokens).toBe(115_200);
  });

  it("型号表 32K：W 驱动预算 32000 × 0.9 = 28800", async () => {
    const w = await resolveContextWindow(
      fakeRepo([provider("gp1", [model("gm32", 32_000)])]),
      { providerId: "gp1", modelId: "gm32" },
    );
    expect(w).toBe(32_000);
    expect(createContextPipelineForAgent(agentConfig(), w).budgetTokens).toBe(28_800);
  });

  it("W 查不到（型号未配 contextWindow）：回退默认 80000 × 0.9 = 72000", async () => {
    const w = await resolveContextWindow(
      fakeRepo([provider("gp1", [model("gmNoW")])]),
      { providerId: "gp1", modelId: "gmNoW" },
    );
    expect(w).toBeUndefined();
    expect(createContextPipelineForAgent(agentConfig(), w).budgetTokens).toBe(72_000);
  });

  it("W 优先于 agent 显式 maxContextTokens（双源统一后的优先级）", async () => {
    const w = await resolveContextWindow(
      fakeRepo([provider("gp1", [model("gm128", 128_000)])]),
      { providerId: "gp1", modelId: "gm128" },
    );
    const pipeline = createContextPipelineForAgent(agentConfig({ maxContextTokens: 32_000 }), w);
    expect(pipeline.budgetTokens).toBe(115_200);
  });
});

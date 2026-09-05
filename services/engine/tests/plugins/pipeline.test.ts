import { describe, it, expect } from "vitest";
import { Context } from "cordis";
import type { AgentConfig } from "@cloudmind/shared";
import * as pipelinePlugin from "../../src/plugins/pipeline/index.js";

// P5 pipeline 插件挂载测试：ctx.pipeline 工厂面上架 + 工厂预算语义
// （budgetTokens = floor(maxContextTokens × 0.9)，显式窗口优先于 agent 配置）。
describe("plugins/pipeline（P5）", () => {
  it("ctx.pipeline 上架：createContextPipelineForAgent 可用", async () => {
    const ctx = new Context();
    await ctx.plugin(pipelinePlugin);
    expect(typeof ctx.pipeline.createContextPipelineForAgent).toBe("function");
  });

  it("工厂语义不变：缺省 80_000→72_000；agent 显式 maxContextTokens 生效；显式窗口优先", async () => {
    const ctx = new Context();
    await ctx.plugin(pipelinePlugin);
    const create = ctx.pipeline.createContextPipelineForAgent;
    expect(create({} as AgentConfig).budgetTokens).toBe(72_000);
    expect(create({ maxContextTokens: 5000 } as AgentConfig).budgetTokens).toBe(4500);
    expect(create({ maxContextTokens: 5000 } as AgentConfig, 6000).budgetTokens).toBe(5400);
  });
});

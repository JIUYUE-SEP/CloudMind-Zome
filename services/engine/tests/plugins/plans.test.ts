import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { PlanManager } from "../../src/plan/manager.js";
import * as logPlugin from "../../src/plugins/log/index.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as llmPlugin from "../../src/plugins/llm/index.js";
import * as toolsPlugin from "../../src/plugins/tools/index.js";
import * as skillsPlugin from "../../src/plugins/skills/index.js";
import * as memoryPlugin from "../../src/plugins/memory/index.js";
import * as mindPlugin from "../../src/plugins/mind/index.js";
import * as pipelinePlugin from "../../src/plugins/pipeline/index.js";
import * as computePlugin from "../../src/plugins/compute/index.js";
import * as agentsPlugin from "../../src/plugins/agents/index.js";
import * as plansPlugin from "../../src/plugins/plans/index.js";

// P7c plans 插件挂载测试：inject ['agents','llm'] PENDING 语义 + ctx.plans
// 上架 + getPlanManager 懒创建/缓存/agent 不存在返回 undefined（自 bootstrap
// 逐字迁入的语义）。agents 依赖链挂载形态同 tests/plugins/agents.test.ts。
describe("plugins/plans（P7c）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plans-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function mountDeps(ctx: Context): Promise<void> {
    await ctx.plugin(logPlugin);
    await ctx.plugin(configPlugin);
    await ctx.plugin(llmPlugin);
    await ctx.plugin(toolsPlugin);
    await ctx.plugin(memoryPlugin);
    await ctx.plugin(mindPlugin);
    await ctx.plugin(pipelinePlugin);
    await ctx.plugin(computePlugin);
    await ctx.plugin(skillsPlugin, { getAgentConfig: async () => undefined });
    await ctx.plugin(agentsPlugin, agentsConfig);
  }

  const agentsConfig = {
    getSubagentServices: () => ({
      subagentDispatcher: {} as never,
      subagentSwarm: {} as never,
      puppetModelService: {} as never,
      intermindService: {} as never,
    }),
    getSidecar: () => ({} as never),
  };

  it("插件元数据：name / inject ['agents','llm'] / apply 四件套可读", () => {
    expect(plansPlugin.name).toBe("plans");
    expect(plansPlugin.inject).toEqual(["agents", "llm"]);
    expect(typeof plansPlugin.apply).toBe("function");
  });

  it("inject ['agents','llm'] 未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(plansPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("plans")).toBeUndefined();
  });

  it("getPlanManager：agent 不存在返回 undefined", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(plansPlugin);

    expect(await ctx.plans.getPlanManager("nonexistent")).toBeUndefined();
  });

  it("getPlanManager：懒创建 + 缓存（同 agent 两次取同一实例），模型回落链接 agent 配置", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(plansPlugin);

    await ctx.agents.agentRepository.save("a1", {
      id: "a1",
      name: "Test",
      persona: "",
      model: "mock",
      skills: [],
      tools: [],
    });

    const m1 = await ctx.plans.getPlanManager("a1");
    expect(m1).toBeInstanceOf(PlanManager);
    // 缓存：第二次取是同一实例（原 bootstrap Map 缓存语义）
    expect(await ctx.plans.getPlanManager("a1")).toBe(m1);
    // 模型回落链 `modelId || model || "gpt-4o"`：只配 model 时取 model
    const internals = m1 as unknown as { options: { model: string } };
    expect(internals.options.model).toBe("mock");
    // load() 恢复后可用：启发式分步建 plan 冒烟（不触 LLM）
    const plan = await m1!.createPlan("- step one");
    expect(plan.steps).toHaveLength(1);
    expect(plan.status).toBe("pending");
  });
});

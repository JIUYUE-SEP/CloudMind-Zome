import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { IntermindService } from "../../src/intermind/service.js";
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
import * as intermindPlugin from "../../src/plugins/intermind/index.js";

// P7d intermind 插件挂载测试：inject ['agents'] PENDING 语义 + ctx.intermind
// 上架 + 写信/会话检索行为冒烟（搭车路径不建 worker；agents 依赖链挂载形态
// 同 tests/plugins/plans.test.ts）。
describe("plugins/intermind（P7d）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "intermind-plugin-test-"));
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

  it("插件元数据：name / inject ['agents'] / apply 四件套可读", () => {
    expect(intermindPlugin.name).toBe("intermind");
    expect(intermindPlugin.inject).toEqual(["agents"]);
    expect(typeof intermindPlugin.apply).toBe("function");
  });

  it("inject ['agents'] 未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(intermindPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("intermind")).toBeUndefined();
  });

  it("ctx.intermind 上架：IntermindService 实例；写信双写 + 会话检索（搭车路径不建 worker）", async () => {
    const ctx = new Context();
    await mountDeps(ctx);
    await ctx.plugin(intermindPlugin);

    expect(ctx.intermind).toBeInstanceOf(IntermindService);

    await ctx.agents.agentRepository.save("a1", {
      id: "a1",
      name: "甲",
      persona: "",
      model: "mock",
      skills: [],
      tools: [],
    });
    await ctx.agents.agentRepository.save("a2", {
      id: "a2",
      name: "乙",
      persona: "",
      model: "mock",
      skills: [],
      tools: [],
    });

    // 搭车（wake:false）：只落盘不唤醒——不触发 getAgentWorker，无需真 worker
    const result = await ctx.intermind.send("a1", "a2", "你好，乙", { wake: false });
    expect(result).toMatchObject({ recipientSessionId: "intermind:a1", woke: false });

    // 邮箱对称双写：接收方来信线程与发送方来往线程各一条
    expect(await ctx.intermind.listMessages("a2", "a1")).toHaveLength(1);
    expect(await ctx.intermind.listMessages("a1", "a2")).toHaveLength(1);
    // 会话检索：两侧各自可见对端
    expect(await ctx.intermind.listSessions("a2")).toMatchObject([{ peer: "a1", count: 1 }]);
    expect(await ctx.intermind.listSessions("a1")).toMatchObject([{ peer: "a2", count: 1 }]);
  });
});

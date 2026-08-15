import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as computePlugin from "../../src/plugins/compute/index.js";

// P5 compute 插件挂载测试：inject ['config'] 等待语义 + W 查找链/usage 面行为不变。
describe("plugins/compute（P5）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "compute-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("inject ['config'] 未就位时不激活（PENDING），config 上架后激活", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(computePlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0/ACTIVE=2）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("compute")).toBeUndefined();

    await ctx.plugin(configPlugin);
    const deadline = Date.now() + 2000;
    while (fiber.state !== 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fiber.state).toBe(2);
    expect(typeof ctx.compute.resolveContextWindow).toBe("function");
  });

  it("W 查找链行为不变：无 configRepository 时回落 undefined（留痕降级）", async () => {
    const ctx = new Context();
    await ctx.plugin(configPlugin);
    await ctx.plugin(computePlugin);
    const resolved = await ctx.compute.resolveContextWindow(undefined, {
      providerId: "p1",
      modelId: "m1",
    });
    expect(resolved).toBeUndefined();
  });

  it("aggregateUsage 行为不变：空数据目录返回空聚合", async () => {
    const ctx = new Context();
    await ctx.plugin(configPlugin);
    await ctx.plugin(computePlugin);
    expect(await ctx.compute.aggregateUsage(tempDir)).toEqual({
      dates: [],
      tokens: [],
      byAgent: [],
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SOUL_TEMPLATE } from "../../src/mind/mind-files.js";
import { restoreDataDir } from "../helpers/env.js";
import * as mindPlugin from "../../src/plugins/mind/index.js";

// P4 mind 插件挂载测试：ctx.mind 灵魂层面可用，loadSoul 缺档兜底语义不变。
describe("plugins/mind（P4）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("ctx.mind 上架：六个函数面齐全", async () => {
    const ctx = new Context();
    await ctx.plugin(mindPlugin);
    for (const fn of [
      "loadSoul",
      "loadMindChunks",
      "retrieveMindChunks",
      "ensureMindFiles",
      "appendMindExperiences",
      "isInjectionSuspect",
    ] as const) {
      expect(typeof ctx.mind[fn]).toBe("function");
    }
  });

  it("loadSoul 语义不变：SOUL.md 缺失时回默认模板", async () => {
    const ctx = new Context();
    await ctx.plugin(mindPlugin);
    // loadSoul 对模板做 trim（尾部换行差异属既有行为），按去尾空白比对
    const soul = await ctx.mind.loadSoul("nonexistent-agent");
    expect(soul.trim()).toBe(DEFAULT_SOUL_TEMPLATE.trim());
  });
});

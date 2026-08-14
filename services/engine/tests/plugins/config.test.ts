import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigRepository } from "../../src/config/repository.js";
import { restoreDataDir } from "../helpers/env.js";
import * as configPlugin from "../../src/plugins/config/index.js";

// P1 config 插件挂载测试：ctx.config 可用 + load 语义不变（空目录回默认配置）。
// 环境隔离照 tests/config/repository.test.ts 的 CLOUDMIND_DATA_DIR 模式。
describe("plugins/config（P1）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("挂载后 ctx.config 为 ConfigRepository 实例", async () => {
    const ctx = new Context();
    await ctx.plugin(configPlugin);
    expect(ctx.config).toBeInstanceOf(ConfigRepository);
  });

  it("load 语义不变：空数据目录返回默认配置（providers 空、memory 默认值）", async () => {
    const ctx = new Context();
    await ctx.plugin(configPlugin);
    const loaded = await ctx.config.load();
    expect(loaded.providers).toEqual([]);
    expect(loaded.settings.memory).toEqual({
      compactThreshold: 0.8,
      keepRecent: 3,
      hotMemoryLimit: 10,
      warmMemoryLimit: 20,
    });
  });
});

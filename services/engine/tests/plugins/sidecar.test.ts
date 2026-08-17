import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { SidecarClient } from "../../src/sidecar/client.js";
import * as sidecarPlugin from "../../src/plugins/sidecar/index.js";

// P9 sidecar 插件挂载测试：SidecarClient 单例上架 ctx.sidecar
// （构造只记地址，proto 加载/连接惰性——挂载无网络副作用）。
describe("plugins/sidecar（P9）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("插件元数据：name / inject [] / apply 四件套可读", () => {
    expect(sidecarPlugin.name).toBe("sidecar");
    expect(sidecarPlugin.inject).toEqual([]);
    expect(typeof sidecarPlugin.apply).toBe("function");
  });

  it("ctx.sidecar 上架：SidecarClient 单例", async () => {
    const ctx = new Context();
    await ctx.plugin(sidecarPlugin);
    expect(ctx.sidecar).toBeInstanceOf(SidecarClient);
  });
});

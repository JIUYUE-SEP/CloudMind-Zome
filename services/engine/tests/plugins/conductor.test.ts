import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import * as conductorPlugin from "../../src/plugins/conductor/index.js";

// P7a conductor 插件挂载测试：ctx.conductor 上架面（sessionRepository 单例）
// + repository 实例语义（写入一条 session 再读回）。
describe("plugins/conductor（P7a）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("插件元数据：name / inject 空 / apply 四件套可读", () => {
    expect(conductorPlugin.name).toBe("conductor");
    expect(conductorPlugin.inject).toEqual([]);
    expect(typeof conductorPlugin.apply).toBe("function");
  });

  it("ctx.conductor 上架：sessionRepository 单例（SessionRepository 实例）", async () => {
    const ctx = new Context();
    await ctx.plugin(conductorPlugin);
    expect(ctx.conductor.sessionRepository).toBeInstanceOf(SessionRepository);
    // 单例语义：同一 fiber 面内两次取用是同一实例（原 ApiContext 单例语义不变）
    expect(ctx.conductor.sessionRepository).toBe(ctx.conductor.sessionRepository);
  });

  it("repository 实例语义不变：写入一条 session 再读回", async () => {
    const ctx = new Context();
    await ctx.plugin(conductorPlugin);
    const repo = ctx.conductor.sessionRepository;
    const created = await repo.create({ name: "Group", agentIds: ["a1", "a2"], type: "group" });
    const got = await repo.get(created.id);
    expect(got).toBeDefined();
    expect(got?.name).toBe("Group");
    expect(got?.agentIds).toEqual(["a1", "a2"]);
  });
});

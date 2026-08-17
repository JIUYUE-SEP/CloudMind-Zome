import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import * as blueprintPlugin from "../../src/plugins/blueprint/index.js";

// P7a blueprint 插件挂载测试：ctx.blueprint 上架面（blueprintRepository 单例）
// + repository 实例语义（写入一条 blueprint 再读回）。
describe("plugins/blueprint（P7a）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("插件元数据：name / inject 空 / apply 四件套可读", () => {
    expect(blueprintPlugin.name).toBe("blueprint");
    expect(blueprintPlugin.inject).toEqual([]);
    expect(typeof blueprintPlugin.apply).toBe("function");
  });

  it("ctx.blueprint 上架：blueprintRepository 单例（BlueprintRepository 实例）", async () => {
    const ctx = new Context();
    await ctx.plugin(blueprintPlugin);
    expect(ctx.blueprint.blueprintRepository).toBeInstanceOf(BlueprintRepository);
    // 单例语义：同一 fiber 面内两次取用是同一实例（原 ApiContext 单例语义不变）
    expect(ctx.blueprint.blueprintRepository).toBe(ctx.blueprint.blueprintRepository);
  });

  it("repository 实例语义不变：写入一条 blueprint 再读回", async () => {
    const ctx = new Context();
    await ctx.plugin(blueprintPlugin);
    const repo = ctx.blueprint.blueprintRepository;
    const created = await repo.create({
      name: "Flow",
      nodes: [{ id: "n1", type: "start", x: 0, y: 0 }],
      edges: [],
    });
    const got = await repo.get(created.id);
    expect(got).toBeDefined();
    expect(got?.name).toBe("Flow");
    expect(got?.nodes).toHaveLength(1);
  });
});

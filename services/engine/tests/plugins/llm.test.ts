import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@cloudmind/shared";
import { restoreDataDir } from "../helpers/env.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as llmPlugin from "../../src/plugins/llm/index.js";

// P2 llm 插件挂载测试：inject 等待语义 + 工厂面上架 + e2e/mock 分支语义不变。
// 环境隔离照 tests/plugins/config.test.ts 的 CLOUDMIND_DATA_DIR 模式。
describe("plugins/llm（P2）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("inject ['config'] 未就位时不激活（PENDING 等待），config 上架后激活", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(llmPlugin);
    // cordis rc.8 语义实测：await fiber 对 PENDING 立即落定（inertia 为空即返回），
    // 不等于激活——激活与否看公开的 fiber.state（PENDING=0 / ACTIVE=2；
    // FiberState 是 const enum 无运行时对象，按数值比对）
    await fiber;
    expect(fiber.state).toBe(0); // PENDING：inject 未就位，apply 未执行
    expect(ctx.get("llm")).toBeUndefined();

    await ctx.plugin(configPlugin);
    // config 上架触发 notify → llm fiber 异步激活，轮询等落定（上限 2s）
    const deadline = Date.now() + 2000;
    while (fiber.state !== 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fiber.state).toBe(2); // ACTIVE
    expect(typeof ctx.llm.createProvider).toBe("function");
  });

  it("ctx.llm.createProvider：未配置 providerId 返回 ErrorLLMProvider（占位语义不变）", async () => {
    const ctx = new Context();
    await ctx.plugin(configPlugin);
    await ctx.plugin(llmPlugin);
    const provider = await ctx.llm.createProvider({ id: "a1" } as AgentConfig);
    // ErrorLLMProvider.name === "error"（provider/llm.ts:15）
    expect(provider.name).toBe("error");
  });
});

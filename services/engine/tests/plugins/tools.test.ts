import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@cloudmind/shared";
import { restoreDataDir } from "../helpers/env.js";
import * as toolsPlugin from "../../src/plugins/tools/index.js";

// P3 任务 2：tools 插件挂载 + forAgent 装配语义（白名单 filter + MCP 合并）。
// CLOUDMIND_DATA_DIR 指向空临时目录 → mcp-servers.json 缺失 → MCP 工具为空集。
describe("plugins/tools（P3）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("ctx.tools 上架：内置清单 / MCP 空集 / manager 透传面", async () => {
    const ctx = new Context();
    await ctx.plugin(toolsPlugin);
    const builtin = ctx.tools.getBuiltin();
    expect(builtin.length).toBeGreaterThan(0);
    expect(builtin.some((t) => t.name === "dispatch_subagent")).toBe(true);
    expect(ctx.tools.getMcp()).toEqual([]);
    expect(ctx.tools.manager).toBeDefined();
  });

  it("forAgent：白名单 filter + MCP 合并语义（与白名单外零交集）", async () => {
    const ctx = new Context();
    await ctx.plugin(toolsPlugin);
    const picked = ctx.tools.forAgent({ id: "a1", tools: ["dispatch_subagent"] } as AgentConfig);
    expect(picked.map((t) => t.name)).toEqual(["dispatch_subagent"]);
    // 未配置 tools 字段 → 空工具集（resolveConfiguredTools 归一语义不变）
    const none = ctx.tools.forAgent({ id: "a2" } as AgentConfig);
    expect(none).toEqual([]);
  });
});

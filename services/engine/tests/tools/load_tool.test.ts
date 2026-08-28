import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadTool } from "../../src/tools/builtin/load_tool.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";
import { DynamicToolLoader } from "../../src/core/dynamic-tool-loader.js";
import type { Tool, ToolContext } from "../../src/tools/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "load-tool-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeDynamicTool(name: string): Tool {
  return {
    name,
    description: `${name} 的完整描述。`,
    parameters: z.object({ path: z.string().min(1) }),
    accesses: [{ resource: "network", action: "read" }],
    requiresApproval: true,
    async execute() {
      return { success: true, output: "ok" };
    },
  };
}

function makeCtx(loader?: DynamicToolLoader): ToolContext {
  return {
    agentId: "a1",
    workspaceDir: tmpDir,
    approve: async () => true,
    services: loader ? { dynamicToolLoader: loader } : {},
  };
}

function makeLoader(dynamicTools: Tool[]): DynamicToolLoader {
  return new DynamicToolLoader([...getBuiltinTools(), ...dynamicTools]);
}

describe("load_tool 工具（spec 决策 3/5）", () => {
  it("requiresApproval=false、memory/read 声明，注册为第 15 件内置", () => {
    expect(loadTool.requiresApproval).toBe(false);
    expect(loadTool.accesses).toContainEqual({ resource: "memory", action: "read" });
    const tools = getBuiltinTools();
    expect(tools).toHaveLength(15);
    expect(tools[14]!.name).toBe("load_tool");
  });

  it("schema 边界：空数组 / 超 8 件 / 非字符串 / 空串名全拦", async () => {
    const loader = makeLoader([makeDynamicTool("mcp__a__t1")]);
    const ctx = makeCtx(loader);
    for (const bad of [
      { names: [] },
      { names: Array.from({ length: 9 }, (_, i) => `mcp__a__t${i}`) },
      { names: [42] },
      { names: [""] },
      {},
    ]) {
      const result = await loadTool.execute(ctx, bad);
      expect(result.success).toBe(false);
    }
    expect(loader.loadedTools()).toEqual([]);
  });

  it("无 loader 注入 / 零动态工具 agent：返回指引错误", async () => {
    const noLoader = await loadTool.execute(makeCtx(), { names: ["mcp__a__t1"] });
    expect(noLoader.success).toBe(false);
    expect(String(noLoader.error)).toContain("无可用动态工具");

    const emptyLoader = await loadTool.execute(makeCtx(makeLoader([])), { names: ["mcp__a__t1"] });
    expect(emptyLoader.success).toBe(false);
    expect(String(emptyLoader.error)).toContain("无可用动态工具");
  });

  it("未知名：fail-closed 错误 + 可用名录，不写 loaded set", async () => {
    const loader = makeLoader([makeDynamicTool("mcp__a__t1")]);
    const result = await loadTool.execute(makeCtx(loader), { names: ["mcp__a__ghost"] });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("mcp__a__ghost");
    expect(String(result.error)).toContain("mcp__a__t1");
    expect(loader.loadedTools()).toEqual([]);
  });

  it("内置名：返回「已常驻，无需取回」错误", async () => {
    const loader = makeLoader([makeDynamicTool("mcp__a__t1")]);
    const result = await loadTool.execute(makeCtx(loader), { names: ["read_file"] });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("已常驻");
    expect(String(result.error)).toContain("read_file");
    expect(loader.loadedTools()).toEqual([]);
  });

  it("混合非法（新动态 + 内置名）：整体原子拒绝，合法那件也不写 set", async () => {
    const loader = makeLoader([makeDynamicTool("mcp__a__t1")]);
    const result = await loadTool.execute(makeCtx(loader), { names: ["mcp__a__t1", "write_file"] });
    expect(result.success).toBe(false);
    expect(loader.loadedTools()).toEqual([]);
  });

  it("成功：返回每件工具 name/description/parameters 全文 + 注入提示，loaded set 更新", async () => {
    const loader = makeLoader([makeDynamicTool("mcp__a__t1"), makeDynamicTool("mcp__a__t2")]);
    const result = await loadTool.execute(makeCtx(loader), { names: ["mcp__a__t1", "mcp__a__t2"] });
    expect(result.success).toBe(true);
    const output = (result as { output: { tools: { name: string; description: string; parameters: unknown }[]; note: string } }).output;
    expect(output.tools).toHaveLength(2);
    expect(output.tools[0]!.name).toBe("mcp__a__t1");
    expect(output.tools[0]!.description).toBe("mcp__a__t1 的完整描述。");
    // parameters 为 JSON Schema 全文（zodToJsonSchema 同构）
    const schema = output.tools[0]!.parameters as { type: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("path");
    expect(output.note).toContain("注入");
    // MRU 序：最近取回在前
    expect(loader.loadedTools().map((t) => t.name)).toEqual(["mcp__a__t2", "mcp__a__t1"]);
  });

  it("重复取回：仍成功返回全文（resident 不视为错误）", async () => {
    const loader = makeLoader([makeDynamicTool("mcp__a__t1")]);
    await loadTool.execute(makeCtx(loader), { names: ["mcp__a__t1"] });
    const again = await loadTool.execute(makeCtx(loader), { names: ["mcp__a__t1"] });
    expect(again.success).toBe(true);
    const output = (again as { output: { tools: { name: string }[] } }).output;
    expect(output.tools.map((t) => t.name)).toEqual(["mcp__a__t1"]);
  });
});

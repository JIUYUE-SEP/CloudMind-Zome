import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  DynamicToolLoader,
  DYNAMIC_TOOL_LOADED_CAP,
  CATALOG_BLURB_MAX,
} from "../../src/core/dynamic-tool-loader.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";
import type { Tool } from "../../src/tools/types.js";

function makeTool(name: string, description = `${name} 的描述。第二句。`): Tool {
  return {
    name,
    description,
    parameters: z.object({ value: z.string().optional() }),
    accesses: [{ resource: "network", action: "read" }],
    async execute() {
      return { success: true, output: "ok" };
    },
  };
}

/** 全量注册表 = 内置 15 件 + 给定动态工具（生产同源：worker config.tools 同构） */
function makeLoader(dynamicTools: Tool[]): DynamicToolLoader {
  return new DynamicToolLoader([...getBuiltinTools(), ...dynamicTools]);
}

describe("DynamicToolLoader（spec 决策 4）", () => {
  it("构造滤出 mcp__/ext__ 动态工具：内置全排除，dynamicCount 正确", () => {
    const loader = makeLoader([makeTool("mcp__fs__read"), makeTool("ext__p__greet"), makeTool("plain_tool")]);
    expect(loader.dynamicCount).toBe(2);
    expect(loader.availableNames()).toEqual(["mcp__fs__read", "ext__p__greet"]);
    expect(loader.catalog().map((e) => e.name)).toEqual(["mcp__fs__read", "ext__p__greet"]);
  });

  it("load 成功：fresh 入 loaded set，catalog 只列未 loaded", () => {
    const loader = makeLoader([makeTool("mcp__a__t1"), makeTool("mcp__a__t2")]);
    const result = loader.load(["mcp__a__t1"]);
    expect(result.loaded.map((t) => t.name)).toEqual(["mcp__a__t1"]);
    expect(result.unknown).toEqual([]);
    expect(result.resident).toEqual([]);
    expect(loader.loadedTools().map((t) => t.name)).toEqual(["mcp__a__t1"]);
    expect(loader.catalog().map((e) => e.name)).toEqual(["mcp__a__t2"]);
  });

  it("未知名：fail-closed 归 unknown，loaded set 原子不动", () => {
    const loader = makeLoader([makeTool("mcp__a__t1"), makeTool("mcp__a__t2")]);
    loader.load(["mcp__a__t1"]);
    const result = loader.load(["mcp__a__ghost", "mcp__a__t2"]);
    expect(result.unknown).toEqual(["mcp__a__ghost"]);
    expect(result.loaded).toEqual([]);
    // 原子性（spec 4.3）：混入未知名整体不写 set——t2 也不入
    expect(loader.loadedTools().map((t) => t.name)).toEqual(["mcp__a__t1"]);
  });

  it("内置名：归 resident 且整体 fail-closed，不写 loaded set", () => {
    const loader = makeLoader([makeTool("mcp__a__t1")]);
    const result = loader.load(["read_file", "mcp__a__t1"]);
    expect(result.resident).toEqual(["read_file"]);
    expect(result.loaded).toEqual([]);
    expect(loader.loadedTools()).toEqual([]);
  });

  it("重复取回：归 resident 且刷新 MRU（挪到键序头部）", () => {
    const loader = makeLoader([makeTool("mcp__a__t1"), makeTool("mcp__a__t2"), makeTool("mcp__a__t3")]);
    loader.load(["mcp__a__t1", "mcp__a__t2", "mcp__a__t3"]);
    const result = loader.load(["mcp__a__t1"]);
    expect(result.resident).toEqual(["mcp__a__t1"]);
    expect(result.loaded).toEqual([]);
    // MRU：最近取回在前（halve 保前部 = 保最近取回，主控终审倒序修复）
    expect(loader.loadedTools().map((t) => t.name)).toEqual(["mcp__a__t1", "mcp__a__t3", "mcp__a__t2"]);
  });

  it(`第 ${DYNAMIC_TOOL_LOADED_CAP + 1} 件取回：逐出最久未用`, () => {
    const tools = Array.from({ length: DYNAMIC_TOOL_LOADED_CAP + 1 }, (_, i) => makeTool(`mcp__s__t${i}`));
    const loader = makeLoader(tools);
    loader.load(tools.slice(0, DYNAMIC_TOOL_LOADED_CAP).map((t) => t.name));
    expect(loader.loadedTools()).toHaveLength(DYNAMIC_TOOL_LOADED_CAP);
    // 刷新 t0（变成最近使用）→ 逐出的应是最久未用的 t1
    loader.load(["mcp__s__t0"]);
    loader.load([`mcp__s__t${DYNAMIC_TOOL_LOADED_CAP}`]);
    const names = loader.loadedTools().map((t) => t.name);
    expect(names).toHaveLength(DYNAMIC_TOOL_LOADED_CAP);
    expect(names).toContain("mcp__s__t0");
    expect(names).toContain(`mcp__s__t${DYNAMIC_TOOL_LOADED_CAP}`);
    expect(names).not.toContain("mcp__s__t1");
  });

  it("catalog blurb：取描述首句，超 80 截断", () => {
    const long = "x".repeat(CATALOG_BLURB_MAX + 30);
    const loader = makeLoader([
      makeTool("mcp__a__t1", "读取文件。详细说明第二句。"),
      makeTool("mcp__a__t2", `${long}。尾句`),
    ]);
    const [e1, e2] = loader.catalog();
    expect(e1!.blurb).toBe("读取文件。");
    expect(e2!.blurb.length).toBeLessThanOrEqual(CATALOG_BLURB_MAX + 1); // 截断 + …
    expect(e2!.blurb.endsWith("…")).toBe(true);
  });

  it("classify 纯分类不落状态：fresh/repeat/builtin/unknown 四分互斥", () => {
    const loader = makeLoader([makeTool("mcp__a__t1"), makeTool("mcp__a__t2")]);
    loader.load(["mcp__a__t1"]);
    const c = loader.classify(["mcp__a__t1", "mcp__a__t2", "read_file", "ghost"]);
    expect(c.fresh.map((t) => t.name)).toEqual(["mcp__a__t2"]);
    expect(c.repeat.map((t) => t.name)).toEqual(["mcp__a__t1"]);
    expect(c.builtin).toEqual(["read_file"]);
    expect(c.unknown).toEqual(["ghost"]);
    // 纯：loaded set 与 MRU 序均未变
    expect(loader.loadedTools().map((t) => t.name)).toEqual(["mcp__a__t1"]);
  });

  it("loadSeqOf：成功提交（含重复取回）单调 +1，fail-closed 不进位", () => {
    const loader = makeLoader([makeTool("mcp__a__t1"), makeTool("mcp__a__t2")]);
    expect(loader.loadSeqOf("mcp__a__t1")).toBe(0);
    loader.load(["mcp__a__t1"]);
    expect(loader.loadSeqOf("mcp__a__t1")).toBe(1);
    // 重复取回也进位——turn 对账「显式复活」判据
    loader.load(["mcp__a__t1"]);
    expect(loader.loadSeqOf("mcp__a__t1")).toBe(2);
    expect(loader.loadSeqOf("mcp__a__t2")).toBe(0);
    // fail-closed 原子拒绝：任何名字都不进位
    loader.load(["mcp__a__t2", "ghost"]);
    expect(loader.loadSeqOf("mcp__a__t2")).toBe(0);
  });
});

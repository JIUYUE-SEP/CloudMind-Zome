import { describe, it, expect } from "vitest";
import { readToolName, isExtTool, isExtToolName } from "../../src/context/tool-classify.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";

/** 生产真形状：worker 经 zodToJsonSchema 构造的 OpenAI function 格式（agent-worker.ts:652-659） */
function fnTool(name: unknown): unknown {
  return {
    type: "function",
    function: { name, description: "d", parameters: { type: "object", properties: {} } },
  };
}

describe("tool-classify（L6 分流：mcp__/ext__ → ext，其余 → core）", () => {
  it("mcp__ 前缀归 ext（MCP server 工具限定名）", () => {
    expect(isExtTool(fnTool("mcp__fs__read_file"))).toBe(true);
    expect(readToolName(fnTool("mcp__fs__read_file"))).toBe("mcp__fs__read_file");
  });

  it("ext__ 前缀归 ext（外部插件工具）", () => {
    expect(isExtTool(fnTool("ext__hello__greet"))).toBe(true);
  });

  it("内置工具名（含 dispatch 系）归 core：编排能力不被预算静默剥夺", () => {
    for (const name of [
      "read_file",
      "write_file",
      "bash",
      "dispatch_subagent",
      "dispatch_subagent_batch",
      "web_search",
      "generate_image",
      "recall",
    ]) {
      expect(isExtTool(fnTool(name))).toBe(false);
    }
  });

  it("无 function 段：读不到名字，fail-safe 归 core", () => {
    expect(readToolName({ type: "function" })).toBeUndefined();
    expect(isExtTool({ type: "function" })).toBe(false);
  });

  it("function 段无 name：fail-safe 归 core", () => {
    expect(readToolName({ function: { description: "d" } })).toBeUndefined();
    expect(isExtTool({ function: { description: "d" } })).toBe(false);
  });

  it("name 非 string：fail-safe 归 core，不误裁", () => {
    for (const bad of [42, null, undefined, { toString: () => "mcp__x__y" }, ["mcp__x__y"]]) {
      expect(readToolName(fnTool(bad))).toBeUndefined();
      expect(isExtTool(fnTool(bad))).toBe(false);
    }
  });

  it("顶层 name 形态（非嵌套 function.name）：不识别，fail-safe 归 core", () => {
    expect(readToolName({ name: "mcp__fs__read_file" })).toBeUndefined();
    expect(isExtTool({ name: "mcp__fs__read_file" })).toBe(false);
  });

  it("非对象 schema（string/null/undefined）：fail-safe 归 core", () => {
    for (const bad of ["mcp__fs__read_file", null, undefined, 42]) {
      expect(readToolName(bad)).toBeUndefined();
      expect(isExtTool(bad)).toBe(false);
    }
  });

  it("防撞车（注册表驱动）：getBuiltinTools 全量内置工具经分流全归 core", () => {
    // 字面量代表名顶不了这个用——新内置工具若误带 mcp__/ext__ 前缀，
    // 会被降级静默裁掉，此例注册表驱动即时撞车
    const builtins = getBuiltinTools();
    expect(builtins.length).toBeGreaterThan(0);
    for (const tool of builtins) {
      expect(isExtTool(fnTool(tool.name))).toBe(false);
    }
  });
});

describe("isExtToolName（名字版，Tool 实例侧用）", () => {
  it("三态：mcp__/ext__ 前缀 true，其余 false", () => {
    expect(isExtToolName("mcp__fs__read")).toBe(true);
    expect(isExtToolName("ext__hello__greet")).toBe(true);
    expect(isExtToolName("read_file")).toBe(false);
    expect(isExtToolName("load_tool")).toBe(false);
    expect(isExtToolName("mcp_")).toBe(false); // 单下划线不算
    expect(isExtToolName("")).toBe(false);
  });

  it("isExtTool 委托恒等：同名 schema 形状判定与名字版一致", () => {
    for (const name of ["mcp__a__t", "ext__b__t", "read_file", "dispatch_subagent"]) {
      expect(isExtTool(fnTool(name))).toBe(isExtToolName(name));
    }
    // 读不到名字时 isExtTool false（fail-safe），不委托出 true
    expect(isExtTool({ nope: true })).toBe(false);
  });
});

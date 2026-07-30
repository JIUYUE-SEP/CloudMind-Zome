/**
 * naming.ts 单测（kimi tool-naming 直搬语义）：
 * 字符白名单 + 下划线折叠、64 字符封顶 FNV-1a 哈希后缀（确定性）、
 * 整 server 映射的同名冲突/空名跳过。
 */
import { describe, it, expect } from "vitest";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { qualifyMcpToolName, sanitizeMcpNamePart } from "../../../src/tools/mcp/naming.js";
import { wrapMcpTools, type McpToolCaller } from "../../../src/tools/mcp/wrapper.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const noopCaller: McpToolCaller = {
  callTool: (): Promise<CallToolResult> =>
    Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
  ping: () => Promise.resolve({}),
};

function fakeMcpTool(name: string): McpTool {
  return { name, inputSchema: { type: "object" } };
}

describe("sanitizeMcpNamePart", () => {
  it("白名单外字符折叠为下划线，连续下划线折叠为一个", () => {
    expect(sanitizeMcpNamePart("Test Server!")).toBe("Test_Server_");
    expect(sanitizeMcpNamePart("a  b")).toBe("a_b");
    expect(sanitizeMcpNamePart("a//b::c")).toBe("a_b_c");
  });

  it("保留白名单字符（含大小写、连字符）", () => {
    expect(sanitizeMcpNamePart("GitHub-CLI_v2")).toBe("GitHub-CLI_v2");
  });

  it("非 ASCII 全部折叠", () => {
    expect(sanitizeMcpNamePart("心智")).toBe("_");
  });
});

describe("qualifyMcpToolName", () => {
  it("短名直通 mcp__<server>__<tool>", () => {
    expect(qualifyMcpToolName("demo", "ping")).toBe("mcp__demo__ping");
  });

  it("超过 64 字符：截断 + FNV-1a 哈希后缀，总长恰为 64", () => {
    const name = qualifyMcpToolName("a".repeat(40), "b".repeat(40));
    expect(name.length).toBe(64);
    expect(name.startsWith("mcp__")).toBe(true);
    expect(/_[0-9a-f]{8}$/.test(name)).toBe(true);
  });

  it("哈希确定性：同输入同输出，不同输入不同后缀", () => {
    const a1 = qualifyMcpToolName("a".repeat(40), "b".repeat(40));
    const a2 = qualifyMcpToolName("a".repeat(40), "b".repeat(40));
    const b = qualifyMcpToolName("a".repeat(40), "c".repeat(40));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("恰为 64 字符时不截断", () => {
    // "mcp__" (5) + server (30) + "__" (2) + tool (27) = 64
    const name = qualifyMcpToolName("s".repeat(30), "t".repeat(27));
    expect(name.length).toBe(64);
    expect(name).toBe(`mcp__${"s".repeat(30)}__${"t".repeat(27)}`);
  });
});

describe("wrapMcpTools 同名冲突/空名跳过", () => {
  it("空名工具跳过，其余正常注册", () => {
    const tools = wrapMcpTools("s", [fakeMcpTool(""), fakeMcpTool("ok")], noopCaller, () => ({}));
    expect(tools.map((t) => t.name)).toEqual(["mcp__s__ok"]);
  });

  it("限定名冲突（sanitize 后撞车）跳过后一个", () => {
    const tools = wrapMcpTools(
      "s",
      [fakeMcpTool("a b"), fakeMcpTool("a_b")],
      noopCaller,
      () => ({}),
    );
    expect(tools.map((t) => t.name)).toEqual(["mcp__s__a_b"]);
  });

  it("options 回调收到原始工具与限定名", () => {
    const seen: string[] = [];
    wrapMcpTools("s", [fakeMcpTool("x")], noopCaller, (_tool, qualifiedName) => {
      seen.push(qualifiedName);
      return {};
    });
    expect(seen).toEqual(["mcp__s__x"]);
  });
});

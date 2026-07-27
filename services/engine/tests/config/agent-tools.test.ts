import { describe, it, expect, vi } from "vitest";
import type { AgentConfig } from "@mindcloud/shared";
import { resolveConfiguredTools } from "../../src/config/agent-tools.js";

function makeConfig(tools: unknown): AgentConfig {
  return {
    id: "a1",
    name: "A1",
    persona: "",
    skills: [],
    tools: tools as string[],
  };
}

describe("resolveConfiguredTools（P3-4，功能 M5）", () => {
  it("tools 缺失/非数组：按空工具集并 warn，不抛 TypeError", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfiguredTools(makeConfig(undefined))).toEqual([]);
    expect(resolveConfiguredTools(makeConfig(null))).toEqual([]);
    expect(resolveConfiguredTools(makeConfig("read_file"))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("tools 为数组：原样返回（空数组不 warn——显式的 chat-only 配置）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfiguredTools(makeConfig(["read_file", "write_file"]))).toEqual([
      "read_file",
      "write_file",
    ]);
    expect(resolveConfiguredTools(makeConfig([]))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

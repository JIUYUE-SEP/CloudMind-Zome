import { logger } from "../../src/logger.js";
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

function makeConfigWithoutSkills(tools: unknown): AgentConfig {
  // 真机形态：agent.json 省略 skills 字段——运行时必须是 undefined，
  // 不能靠 makeConfig 的显式空数组掩盖 TypeError
  const config = makeConfig(tools) as Partial<AgentConfig>;
  delete config.skills;
  return config as AgentConfig;
}

describe("resolveConfiguredTools（P3-4，功能 M5）", () => {
  it("tools 缺失/非数组：按空工具集并 warn，不抛 TypeError", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveConfiguredTools(makeConfig(undefined))).toEqual([]);
    expect(resolveConfiguredTools(makeConfig(null))).toEqual([]);
    expect(resolveConfiguredTools(makeConfig("read_file"))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("tools 为数组：原样返回（空数组不 warn——显式的 chat-only 配置）", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveConfiguredTools(makeConfig(["read_file", "write_file"]))).toEqual([
      "read_file",
      "write_file",
    ]);
    expect(resolveConfiguredTools(makeConfig([]))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("落差可见：配置了技能但白名单不含 skill 工具时 warn 提醒（stage 5 review）", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const withSkill = { ...makeConfig(["read_file"]), skills: ["code-review"] };
    expect(resolveConfiguredTools(withSkill)).toEqual(["read_file"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('"skill"');
    // 白名单已含 skill 或无技能配置：不 warn
    warn.mockClear();
    resolveConfiguredTools({ ...makeConfig(["skill"]), skills: ["code-review"] });
    resolveConfiguredTools(makeConfig(["read_file"]));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skills 缺省：按空技能集处理，不抛 TypeError（真机 #5 修复）", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // 无 skills 字段 + tools 数组（此前 16 行 agentConfig.skills.length 直接崩）
    expect(resolveConfiguredTools(makeConfigWithoutSkills(["read_file"]))).toEqual([
      "read_file",
    ]);
    // 无 skills 字段 + tools 缺省：同样不崩
    expect(resolveConfiguredTools(makeConfigWithoutSkills(undefined))).toEqual([]);
    // skills 非数组（null 等历史脏数据）也按空处理
    expect(resolveConfiguredTools({ ...makeConfig(["read_file"]), skills: null as unknown as string[] })).toEqual([
      "read_file",
    ]);
    // 缺省有 warn（与 tools 缺省同哲学，配置者可见），空数组不 warn
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("未配置 skills 字段"));
    warn.mockClear();
    resolveConfiguredTools(makeConfig(["read_file"]));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

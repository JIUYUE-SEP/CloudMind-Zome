/**
 * Skill 工具测试（阶段 5 一期）：
 * ① 命中——SKILL.md 正文原样返回（经三级目录加载，不二次加工）；
 * ② 不存在——明确错误 + 可用技能名列表（fail-closed，不许模型瞎编）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skillTool } from "../../src/tools/builtin/skill.js";
import { createSkillService } from "../../src/skills/service.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { AgentConfig } from "@mindcloud/shared";

const SKILL_BODY = [
  "Name: code-review",
  "Description: 代码审查规程",
  "Version: 1.2.0",
  "",
  "# 代码审查规程",
  "第一步：先读 diff。",
  "第二步：分级标注。",
].join("\n");

let tmpDir: string;
let originalDataDir: string | undefined;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skill-tool-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  // agent 私有目录（第三级）放一个技能
  const skillDir = path.join(tmpDir, "agents", "a1", "skills", "code-review");
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

  const agentConfig: AgentConfig = {
    id: "a1",
    name: "A1",
    persona: "",
    model: "mock",
    skills: ["code-review"],
    tools: [],
  };
  const skillService = createSkillService({
    getAgentConfig: async (id) => (id === "a1" ? agentConfig : undefined),
    resolveDirs: async (agentId) => [
      path.join(tmpDir, "skills"),
      path.join(tmpDir, "agents", agentId, "skills"),
    ],
  });
  ctx = {
    agentId: "a1",
    workspaceDir: ".",
    approve: async () => true,
    services: { skillService },
  };
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("① Skill 工具命中", () => {
  it("正文原样返回（含 frontmatter 头），免审批", async () => {
    const result = await skillTool.execute(ctx, { name: "code-review" });
    expect(result.success).toBe(true);
    expect(result.output).toBe(SKILL_BODY);
    expect(skillTool.requiresApproval).toBe(false);
  });

  it("只暴露 agent 已配置技能：未配置的技能名按不存在处理", async () => {
    // 目录里另有未配置技能
    const otherDir = path.join(tmpDir, "agents", "a1", "skills", "other-skill");
    await fsp.mkdir(otherDir, { recursive: true });
    await fsp.writeFile(path.join(otherDir, "SKILL.md"), "Name: other-skill\nDescription: 未配置\n", "utf-8");

    const result = await skillTool.execute(ctx, { name: "other-skill" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("不存在");
  });
});

describe("② Skill 工具不存在", () => {
  it("明确错误 + 可用技能名列表", async () => {
    const result = await skillTool.execute(ctx, { name: "ghost" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("技能「ghost」不存在");
    expect(result.error).toContain("code-review");
  });

  it("未接线 skillService 明确报错", async () => {
    const bare: ToolContext = { agentId: "a1", workspaceDir: ".", approve: async () => true, services: {} };
    const result = await skillTool.execute(bare, { name: "code-review" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  });
});

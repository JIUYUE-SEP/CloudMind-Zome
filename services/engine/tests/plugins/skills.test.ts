import { describe, it, expect, afterEach, vi } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../src/logger.js";
import * as skillsPlugin from "../../src/plugins/skills/index.js";
import { findBuiltinSkillsDir } from "../../src/plugins/skills/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(HERE, "../../../..");
const ORIGINAL_ENV = process.env.ZOME_BUILTIN_SKILLS_DIR;

// P3 任务 1：findBuiltinSkillsDir 三分支直测（env 命中 / 向上查找命中 / 全不命中 warn+undefined）。
// 既有覆盖说明：tests/skills/*（loader、active-protection）测 loadSkills/活跃保护，不覆盖本函数；
// tests/packaging/builtin-skills.smoke.test.ts 是端到端打包冒烟（预存红，见 P0 备案）——
// 本文件的三分支直测不与其重复，并接任 P3 期的 builtin-skills 守护。
afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.ZOME_BUILTIN_SKILLS_DIR;
  } else {
    process.env.ZOME_BUILTIN_SKILLS_DIR = ORIGINAL_ENV;
  }
  vi.restoreAllMocks();
});

describe("findBuiltinSkillsDir 三分支（P3）", () => {
  it("分支一：ZOME_BUILTIN_SKILLS_DIR 命中已存在目录 → 直接返回", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zome-builtin-skills-"));
    try {
      process.env.ZOME_BUILTIN_SKILLS_DIR = dir;
      expect(await findBuiltinSkillsDir()).toBe(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("分支二：env 未设 → 从 cwd 向上查找命中 monorepo packages/skills", async () => {
    delete process.env.ZOME_BUILTIN_SKILLS_DIR;
    // vitest 运行 cwd = services/engine，向上 2 级即 monorepo 根的 packages/skills
    expect(await findBuiltinSkillsDir()).toBe(path.join(MONOREPO_ROOT, "packages", "skills"));
  });

  it("分支三：env 指向不存在目录 + 向上 6 级不命中 → warn 留痕并返回 undefined", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.ZOME_BUILTIN_SKILLS_DIR = path.join(os.tmpdir(), "zome-skills-nonexistent-dir");
    const neutral = await fs.mkdtemp(path.join(os.tmpdir(), "zome-skills-neutral-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(neutral); // Temp 上溯链无 packages/skills
      expect(await findBuiltinSkillsDir()).toBeUndefined();
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("ZOME_BUILTIN_SKILLS_DIR 指向的目录不存在"))).toBe(true);
      expect(messages.some((m) => m.includes("未找到内置技能目录"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(neutral, { recursive: true, force: true });
    }
  });
});

describe("plugins/skills 挂载（P3）", () => {
  it("ctx.skills 上架；getAgentConfig 经插件 config 回调进场（批准的过渡形态）", async () => {
    const ctx = new Context();
    await ctx.plugin(skillsPlugin, { getAgentConfig: async () => undefined });
    expect(typeof ctx.skills.list).toBe("function");
    // getAgentConfig 返回 undefined → 空目录（语义同 bootstrap 原闭包）
    expect(await ctx.skills.list("nobody")).toEqual([]);
  });
});

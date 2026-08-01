import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadSkills } from "../../src/skills/loader.js";

describe("loadSkills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-test-"));
    await fs.mkdir(path.join(tmpDir, "core"));
    await fs.writeFile(
      path.join(tmpDir, "core", "SKILL.md"),
      "Name: core\nDescription: fundamental tools\nVersion: 1.0.0\n"
    );
  });

  it("loads skill manifest from directory", async () => {
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("core");
    expect(skills[0].description).toBe("fundamental tools");
  });

  it("解析 YAML frontmatter 格式（生态对齐，优先于行前缀）", async () => {
    await fs.mkdir(path.join(tmpDir, "fm"));
    await fs.writeFile(
      path.join(tmpDir, "fm", "SKILL.md"),
      "---\nname: fm-skill\ndescription: frontmatter 格式\nversion: 2.0.0\n---\n\n# 正文\n\nName: legacy-name-should-not-win\n"
    );
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    const fm = skills.find((s) => s.name === "fm-skill");
    expect(fm).toBeDefined();
    expect(fm!.description).toBe("frontmatter 格式");
    expect(fm!.version).toBe("2.0.0");
    expect(skills.find((s) => s.name === "legacy-name-should-not-win")).toBeUndefined();
  });

  it("frontmatter 值剥首尾引号，缺字段回退缺省", async () => {
    await fs.mkdir(path.join(tmpDir, "quoted"));
    await fs.writeFile(
      path.join(tmpDir, "quoted", "SKILL.md"),
      '---\nname: "quoted-skill"\n---\n\n正文\n'
    );
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    const q = skills.find((s) => s.name === "quoted-skill");
    expect(q).toBeDefined();
    expect(q!.description).toBe("");
    expect(q!.version).toBe("0.1.0");
  });

  it("无 frontmatter 时行前缀格式照常工作（向后兼容）", async () => {
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    expect(skills[0].name).toBe("core");
    expect(skills[0].version).toBe("1.0.0");
  });

  it("UTF-8 BOM 不破坏 frontmatter 解析（review P2-1）", async () => {
    await fs.mkdir(path.join(tmpDir, "bom"));
    await fs.writeFile(
      path.join(tmpDir, "bom", "SKILL.md"),
      "\uFEFF---\nname: bom-skill\ndescription: 带 BOM\nversion: 1.0.0\n---\n\n正文\n"
    );
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    const b = skills.find((s) => s.name === "bom-skill");
    expect(b).toBeDefined();
    expect(b!.description).toBe("带 BOM");
  });

  it("frontmatter 缺 name 时回退 legacy 头（review P2-2）", async () => {
    await fs.mkdir(path.join(tmpDir, "emptyfm"));
    await fs.writeFile(
      path.join(tmpDir, "emptyfm", "SKILL.md"),
      "---\n\n---\n\nName: legacy-wins\nDescription: 空 frontmatter 回退\n"
    );
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    const s = skills.find((s) => s.name === "legacy-wins");
    expect(s).toBeDefined();
    expect(s!.description).toBe("空 frontmatter 回退");
  });

  it("frontmatter 值含冒号保留原文", async () => {
    await fs.mkdir(path.join(tmpDir, "colon"));
    await fs.writeFile(
      path.join(tmpDir, "colon", "SKILL.md"),
      "---\nname: colon-skill\ndescription: a: b: 多冒号\n---\n\n正文\n"
    );
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    expect(skills.find((s) => s.name === "colon-skill")!.description).toBe("a: b: 多冒号");
  });
});

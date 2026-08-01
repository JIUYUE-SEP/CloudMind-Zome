import fs from "node:fs/promises";
import path from "node:path";
import type { Skill, SkillManifest } from "./types.js";

export interface SkillLoadOptions {
  builtinDirs?: string[];
  userDir?: string;
}

export async function loadSkills(options?: SkillLoadOptions): Promise<Skill[]> {
  const dirs: string[] = [];
  if (options?.builtinDirs) dirs.push(...options.builtinDirs);
  if (options?.userDir) dirs.push(options.userDir);

  const skills: Skill[] = [];
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(dir, entry.name);
        const skill = await loadSkill(skillDir);
        if (skill) skills.push(skill);
      }
    } catch {
      // directory may not exist
    }
  }
  return skills;
}

async function loadSkill(skillDir: string): Promise<Skill | undefined> {
  const manifestPath = path.join(skillDir, "SKILL.md");
  const schemaPath = path.join(skillDir, "schema.json");
  try {
    // 剥 UTF-8 BOM：Windows 编辑器（记事本等）保存的 SKILL.md 常带 BOM，不剥会让 frontmatter 正则静默失配
    const manifestContent = (await fs.readFile(manifestPath, "utf-8")).replace(/^\uFEFF/, "");
    const manifest = parseSkillManifest(manifestContent);
    let configSchema: unknown | undefined;
    try {
      configSchema = JSON.parse(await fs.readFile(schemaPath, "utf-8"));
    } catch {
      // schema optional
    }
    // tools/prompts 的实现发现与注册留待后续阶段；
    // content 保留 SKILL.md 全文，运行时注入 system prompt。
    return {
      ...manifest,
      tools: [],
      prompts: [],
      content: manifestContent,
      configSchema,
    };
  } catch {
    return undefined;
  }
}

// 极简 frontmatter 提取：仅解析顶层 `key: value` 标量行（剥首尾引号），
// 不支持多行值/嵌套——清单三字段够用，不为此引入 YAML 依赖。
function extractFrontmatter(content: string): Record<string, string> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[kv[1]] = v;
  }
  return out;
}

function parseSkillManifest(content: string): SkillManifest {
  // 双格式支持（2026-08-01 起）：
  // 1. YAML frontmatter（--- 包裹，小写 name/description/version）——对齐外部技能生态
  //    （kimi/Claude skills 通用格式），name 非空时优先（空块回退 legacy）；
  // 2. 行前缀格式（Name:/Description:/Version:）——CMZ 早期格式，向后兼容回退。
  const fm = extractFrontmatter(content);
  // 优先级判据是 fm.name 非空而非"块存在"：空块/仅无关键的 frontmatter 回退 legacy（review P2-2）
  if (fm && fm["name"]) {
    return {
      name: fm["name"],
      description: fm["description"] || "",
      version: fm["version"] || "0.1.0",
    };
  }
  const lines = content.split("\n");
  const name = extractHeader(lines, "Name:") || "unnamed";
  const description = extractHeader(lines, "Description:") || "";
  const version = extractHeader(lines, "Version:") || "0.1.0";
  return { name, description, version };
}

function extractHeader(lines: string[], prefix: string): string | undefined {
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return undefined;
}

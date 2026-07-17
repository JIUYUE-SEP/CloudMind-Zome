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
    const manifestContent = await fs.readFile(manifestPath, "utf-8");
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

function parseSkillManifest(content: string): SkillManifest {
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

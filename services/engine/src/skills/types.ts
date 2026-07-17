import type { Tool } from "../tools/types.js";

export interface SkillPrompt {
  name: string;
  template: string;
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  tools: Tool[];
  prompts: SkillPrompt[];
  /** SKILL.md 全文，用于注入 system prompt */
  content: string;
  configSchema?: unknown;
}

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  configSchema?: unknown;
}

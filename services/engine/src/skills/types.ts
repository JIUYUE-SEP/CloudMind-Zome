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
  configSchema?: unknown;
}

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  configSchema?: unknown;
}

import type { Skill } from "./types.js";
import { loadSkills, type SkillLoadOptions } from "./loader.js";

export class SkillManager {
  private skills = new Map<string, Skill>();

  async load(options?: SkillLoadOptions): Promise<void> {
    const skills = await loadSkills(options);
    for (const skill of skills) {
      this.skills.set(skill.name, skill);
    }
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }
}

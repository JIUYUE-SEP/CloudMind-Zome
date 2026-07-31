import type { AgentConfig } from "@mindcloud/shared";
import { loadSkills } from "./loader.js";
import type { Skill } from "./types.js";

/**
 * 技能服务（阶段 5 一期，Skill 工具化）：发现与取正文两条通道共用同一套
 * 三级目录加载（loader 不动）。L1 目录（名字+一句话）是发现入口；
 * Skill 工具按名取规程正文（SKILL.md 全文原样，不二次加工）。
 */

export interface SkillEntry {
  name: string;
  description: string;
}

export interface SkillService {
  /** agent 已配置技能的目录条目（L1 发现入口） */
  list(agentId: string): Promise<SkillEntry[]>;
  /** 取 agent 已配置技能的正文（SKILL.md 全文原样）；未配置/不存在返回 undefined */
  getContent(agentId: string, name: string): Promise<string | undefined>;
}

export function createSkillService(deps: {
  getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
  /** 解析三级目录（内置 + 全局 + agent 私有），与 bootstrap 现有组装同源 */
  resolveDirs(agentId: string): Promise<string[]>;
}): SkillService {
  async function resolveAgentSkills(agentId: string): Promise<Skill[]> {
    const agentConfig = await deps.getAgentConfig(agentId);
    if (!agentConfig) return [];
    const names = agentConfig.skills ?? [];
    if (names.length === 0) return [];
    const skills = await loadSkills({ builtinDirs: await deps.resolveDirs(agentId) });
    const byName = new Map(skills.map((s) => [s.name, s]));
    return names
      .map((n) => byName.get(n))
      .filter((s): s is Skill => s !== undefined);
  }

  return {
    async list(agentId) {
      const skills = await resolveAgentSkills(agentId);
      return skills.map((s) => ({ name: s.name, description: s.description }));
    },
    async getContent(agentId, name) {
      const skills = await resolveAgentSkills(agentId);
      return skills.find((s) => s.name === name)?.content;
    },
  };
}

import path from "node:path";
import type { AgentConfig } from "@mindcloud/shared";
import { DocumentStore } from "../memory/document-store.js";
import { getAgentDir, sanitizeAgentId } from "../config/paths.js";
import { loadSkills } from "./loader.js";
import type { Skill } from "./types.js";

/**
 * 技能服务（阶段 5 一期 Skill 工具化 + 二期 promptHistory）：发现与取正文
 * 两条通道共用同一套三级目录加载（loader 不动）。L1 目录（名字+一句话）
 * 是发现入口；Skill 工具按名取规程正文（SKILL.md 全文原样，不二次加工）。
 * 二期：调用记录落 skill-history.jsonl（DocumentStore 原子写/串行队列同范式）。
 */

export interface SkillEntry {
  name: string;
  description: string;
}

/** 技能调用记录（skill-history.jsonl 一行） */
export interface SkillUsageRecord {
  ts: string;
  agentId: string;
  name: string;
  ok: boolean;
  error?: string;
}

export interface SkillService {
  /** agent 已配置技能的目录条目（L1 发现入口） */
  list(agentId: string): Promise<SkillEntry[]>;
  /** 取 agent 已配置技能的正文（SKILL.md 全文原样）；未配置/不存在返回 undefined */
  getContent(agentId: string, name: string): Promise<string | undefined>;
  /** 记录一次 Skill 工具调用（成功或失败原因）；落盘失败由调用方降级（不炸工具） */
  recordUsage(agentId: string, entry: { name: string; ok: boolean; error?: string }): Promise<void>;
  /** 读调用记录（倒序，最新在前；limit 由调用方 clamp） */
  readHistory(agentId: string, limit: number): Promise<SkillUsageRecord[]>;
  /** 清解析缓存（hot reload 后必须调用，否则 TTL 内目录仍是旧的） */
  invalidate(agentId: string): void;
}

export function createSkillService(deps: {
  getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
  /** 解析三级目录（内置 + 全局 + agent 私有），与 bootstrap 现有组装同源 */
  resolveDirs(agentId: string): Promise<string[]>;
}): SkillService {
  // 短 TTL 解析缓存（review 建议）：自动重取在组装路径上每轮逐技能触发解析，
  // 无缓存时轮轮三目录扫描+逐文件读盘。TTL 30s 足够削峰；hot reload 经 invalidate 即刻生效
  const RESOLVE_TTL_MS = 30_000;
  const resolveCache = new Map<string, { at: number; skills: Skill[] }>();

  async function resolveAgentSkills(agentId: string): Promise<Skill[]> {
    const cached = resolveCache.get(agentId);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.skills;
    const agentConfig = await deps.getAgentConfig(agentId);
    if (!agentConfig) return [];
    const names = agentConfig.skills ?? [];
    if (names.length === 0) return [];
    const skills = await loadSkills({ builtinDirs: await deps.resolveDirs(agentId) });
    const byName = new Map(skills.map((s) => [s.name, s]));
    const resolved = names
      .map((n) => byName.get(n))
      .filter((s): s is Skill => s !== undefined);
    resolveCache.set(agentId, { at: Date.now(), skills: resolved });
    return resolved;
  }

  function historyStore(agentId: string): DocumentStore<SkillUsageRecord> {
    sanitizeAgentId(agentId);
    return new DocumentStore<SkillUsageRecord>(
      path.join(getAgentDir(agentId), "skill-history.jsonl"),
    );
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
    async recordUsage(agentId, entry) {
      await historyStore(agentId).appendLine({
        ts: new Date().toISOString(),
        agentId,
        name: entry.name,
        ok: entry.ok,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      });
    },
    async readHistory(agentId, limit) {
      const lines = await historyStore(agentId).readLines();
      return lines.slice(-limit).reverse();
    },
    invalidate(agentId) {
      resolveCache.delete(agentId);
    },
  };
}

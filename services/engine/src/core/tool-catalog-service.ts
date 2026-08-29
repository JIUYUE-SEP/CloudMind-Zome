import type { AgentConfig } from "@mindcloud/shared";
import type { LLMProvider } from "../provider/types.js";
import type { Tool } from "../tools/types.js";
import { isExtToolName } from "../context/tool-classify.js";
import { getBuiltinTools } from "../tools/builtin/index.js";
import { descHashOf, type ToolBlurbEntry, type ToolBlurbFile, type ToolBlurbStore } from "./tool-blurb-store.js";
import { summarizeBlurbs } from "./tool-blurb-summarizer.js";
import { firstSentenceBlurb } from "./dynamic-tool-loader.js";

/** status 四态（spec 决策 1）；builtin 恒 "core" 无管理面 */
export type BlurbStatus = "llm" | "user" | "missing" | "stale";

export interface DynamicCatalogItem {
  name: string;
  /** 展示 blurb：条目命中用条目（user/stale 也展示），无条目回退机械截断 */
  blurb: string;
  source?: "llm" | "user";
  status: BlurbStatus;
}

export interface SkillCatalogItem {
  name: string;
  /** 作者行（SKILL.md description 原文，一个字不动） */
  authorLine: string;
  /** 覆盖行（skill:<name> 条目 blurb；无条目 undefined） */
  overrideBlurb?: string;
  source?: "llm" | "user";
  status: BlurbStatus;
}

export interface BuiltinCatalogItem {
  name: string;
  blurb: string;
  status: "core";
}

export interface ToolCatalog {
  dynamic: DynamicCatalogItem[];
  skills: SkillCatalogItem[];
  builtin: BuiltinCatalogItem[];
}

export interface RegenerateResult {
  generated: string[];
  failed: string[];
  /** user 条目跳过不碰（spec 决策 3：永不被自动覆盖） */
  skipped: string[];
}

export interface ToolCatalogDeps {
  store: ToolBlurbStore;
  /** agent 全量工具表（ctx.tools.forAgent 同语义） */
  toolsForAgent(config: AgentConfig): Tool[];
  /** agent skill 名录（name + 作者行 description） */
  listSkills(agentId: string): Promise<Array<{ name: string; description: string }>>;
  /** PUT 命名空间校验用：全 agent 名录 */
  listAgents(): Promise<AgentConfig[]>;
  /** regenerate 的 provider 链（落 llm_calls 账由注入方包装） */
  createProvider(agentId: string, config: AgentConfig): Promise<LLMProvider>;
  modelOf(config: AgentConfig): string;
}

/** 四态判定（spec 决策 1）：user 永不为 stale（含哈希变——v2 已埋不覆盖语义） */
export function blurbStatusOf(entry: ToolBlurbEntry | undefined, currentDescription: string): BlurbStatus {
  if (!entry) return "missing";
  if (entry.source === "user") return "user";
  return entry.descHash === descHashOf(currentDescription) ? "llm" : "stale";
}

/**
 * skill 覆盖层（spec 决策 2）：命中 `skill:<name>` 条目（user 源 或 哈希与当前
 * SKILL.md 描述一致）用覆盖行，否则作者行。**SKILL.md 原文一个字不动**。
 */
export function applySkillBlurbOverrides(
  skills: Array<{ name: string; description: string }>,
  disk: ToolBlurbFile,
): string[] {
  return skills.map((s) => {
    const entry = disk[`skill:${s.name}`];
    if (entry && (entry.source === "user" || entry.descHash === descHashOf(s.description))) {
      return `- ${s.name}：${entry.blurb}`;
    }
    return `- ${s.name}：${s.description}`;
  });
}

/**
 * 工具目录聚合 + blurb 管理（v3 阶段 1）：三清单（dynamic/skills/builtin）、
 * 手动重生成（缺省只碰 missing/stale，user 跳过）、用户编辑（命名空间
 * fail-closed 校验在路由层调 findDescription）。
 */
export class ToolCatalogService {
  constructor(private readonly deps: ToolCatalogDeps) {}

  async catalog(config: AgentConfig): Promise<ToolCatalog> {
    const disk = await this.deps.store.getAll();
    const dynamic: DynamicCatalogItem[] = this.deps
      .toolsForAgent(config)
      .filter((t) => isExtToolName(t.name))
      .map((t) => {
        const entry = disk[t.name];
        return {
          name: t.name,
          blurb: entry?.blurb ?? firstSentenceBlurb(t.description),
          ...(entry ? { source: entry.source } : {}),
          status: blurbStatusOf(entry, t.description),
        };
      });
    const skills: SkillCatalogItem[] = (await this.deps.listSkills(config.id)).map((s) => {
      const entry = disk[`skill:${s.name}`];
      return {
        name: s.name,
        authorLine: s.description,
        ...(entry ? { overrideBlurb: entry.blurb, source: entry.source } : {}),
        status: blurbStatusOf(entry, s.description),
      };
    });
    const builtin: BuiltinCatalogItem[] = getBuiltinTools().map((t) => ({
      name: t.name,
      blurb: firstSentenceBlurb(t.description),
      status: "core" as const,
    }));
    return { dynamic, skills, builtin };
  }

  /**
   * 手动重生成（spec 决策 3）：缺省 = 本 agent 全部 missing/stale 件；指定
   * names（限定名或 skill:<name>）时只碰名录内非 user 件——user 跳过、
   * 非本 agent 名录进 failed。dynamic 件概括工具描述、skill: 件概括作者行
   * （同一 summarizer）；成功件 upsert source:"llm"，缺件进 failed 不落盘。
   */
  async regenerate(agentId: string, config: AgentConfig, names?: string[]): Promise<RegenerateResult> {
    const disk = await this.deps.store.getAll();
    const pool = new Map<string, string>();
    for (const t of this.deps.toolsForAgent(config)) {
      if (isExtToolName(t.name)) pool.set(t.name, t.description);
    }
    for (const s of await this.deps.listSkills(agentId)) {
      pool.set(`skill:${s.name}`, s.description);
    }

    const targets =
      names && names.length > 0
        ? names
        : [...pool.keys()].filter((key) => {
            const status = blurbStatusOf(disk[key], pool.get(key)!);
            return status === "missing" || status === "stale";
          });

    const generated: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const toGenerate: Array<{ key: string; description: string }> = [];
    for (const key of targets) {
      const description = pool.get(key);
      if (description === undefined) {
        failed.push(key); // 非本 agent 名录（含乱写键名）
        continue;
      }
      if (disk[key]?.source === "user") {
        skipped.push(key); // user 条目跳过不碰
        continue;
      }
      toGenerate.push({ key, description });
    }

    if (toGenerate.length > 0) {
      const provider = await this.deps.createProvider(agentId, config);
      const produced = await summarizeBlurbs(
        provider,
        this.deps.modelOf(config),
        toGenerate.map((p) => ({ name: p.key, description: p.description })),
      );
      const now = new Date().toISOString();
      const upserts: Array<[string, ToolBlurbEntry]> = [];
      for (const p of toGenerate) {
        const blurb = produced.get(p.key);
        if (!blurb) {
          failed.push(p.key); // 降级=缺席不落盘（同 v2 口径）
          continue;
        }
        upserts.push([p.key, { blurb, descHash: descHashOf(p.description), source: "llm", updatedAt: now }]);
        generated.push(p.key);
      }
      await this.deps.store.upsert(upserts);
    }
    return { generated, failed, skipped };
  }

  /** PUT 命名空间校验（fail-closed）：name 须在全局动态工具或某 agent skill 名录内；命中返回当前描述（写 descHash 用） */
  async findDescription(name: string): Promise<string | undefined> {
    const agents = await this.deps.listAgents();
    if (name.startsWith("skill:")) {
      const skillName = name.slice("skill:".length);
      for (const agent of agents) {
        const hit = (await this.deps.listSkills(agent.id)).find((s) => s.name === skillName);
        if (hit) return hit.description;
      }
      return undefined;
    }
    for (const agent of agents) {
      const hit = this.deps
        .toolsForAgent(agent)
        .find((t) => t.name === name && isExtToolName(t.name));
      if (hit) return hit.description;
    }
    return undefined;
  }

  /** 用户编辑（spec 决策 3）：source:"user"，descHash 取当前描述（调用方先过 findDescription 校验） */
  async putUser(name: string, blurb: string, currentDescription: string): Promise<ToolBlurbEntry> {
    const entry: ToolBlurbEntry = {
      blurb,
      descHash: descHashOf(currentDescription),
      source: "user",
      updatedAt: new Date().toISOString(),
    };
    await this.deps.store.upsertOne(name, entry);
    return entry;
  }
}

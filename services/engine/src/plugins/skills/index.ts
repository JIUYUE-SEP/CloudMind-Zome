import path from "node:path";
import fs from "node:fs/promises";
import type { Context } from "cordis";
import type { AgentConfig } from "@mindcloud/shared";
import { logger } from "../../logger.js";
import { getAgentDir, getDataDir } from "../../config/paths.js";
import { createSkillService, type SkillService } from "../../skills/service.js";

/**
 * skills 插件（P3）：SkillService 上架 ctx.skills；findBuiltinSkillsDir 与
 * 三级目录组装闭包自 bootstrap.ts 迁入（语义一字未改）。
 *
 * 过渡形态（P3 任务书批准）：getAgentConfig 依赖 agentRepository
 * （P4/P6 才插件化），本期经**插件 config 回调**进场——
 * `ctx.plugin(skillsPlugin, { getAgentConfig: ... })`，后续期换位 inject。
 * SkillService 内部对 memory/document-store 的值级出边（skills/service.ts:3）
 * 同 P1 config 的批准形态保留直 import，P4 收口。
 */
export const name = "skills";

/** 无 ctx 服务依赖：唯一外部依赖经 config 回调进场（见头注） */
export const inject: string[] = [];

/** 插件 config：批准的过渡形态（见头注），后续期换位 inject */
export interface Config {
  getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
}

declare module "cordis" {
  interface Context {
    /** 技能服务（L1 目录发现 + Skill 工具取正文 + 调用记录） */
    skills: SkillService;
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide(
    "skills",
    createSkillService({
      getAgentConfig: config.getAgentConfig,
      resolveDirs: async (agentId) => {
        const dirs: string[] = [];
        const builtin = await findBuiltinSkillsDir();
        if (builtin) dirs.push(builtin);
        dirs.push(path.join(getDataDir(), "skills"));
        dirs.push(path.join(getAgentDir(agentId), "skills"));
        return dirs;
      },
    }),
  );
}

/** 从 cwd 向上找 monorepo 根下的 packages/skills（内置技能目录）。P3 自 bootstrap.ts 迁入，三分支语义一字未改 */
export async function findBuiltinSkillsDir(): Promise<string | undefined> {
  // env 兜底（功能 review M4）：与 ZOME_PROTO_PATH 同一模式——生产包内
  // 向上查找不命中时，可显式指向内置目录，不再静默丢失
  const fromEnv = process.env.ZOME_BUILTIN_SKILLS_DIR;
  if (fromEnv) {
    const ok = await fs.stat(fromEnv).then((s) => s.isDirectory()).catch(() => false);
    if (ok) return fromEnv;
    logger.warn(`[skills] ZOME_BUILTIN_SKILLS_DIR 指向的目录不存在：${fromEnv}（回退向上查找）`);
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "packages", "skills");
    const ok = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (ok) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 内置目录缺失此前静默吞掉（loader 对不存在目录 catch 跳过），打包排障零线索
  logger.warn(`[skills] 未找到内置技能目录 packages/skills（cwd=${process.cwd()} 向上 6 级不命中），内置 skill 不可用`);
  return undefined;
}

import type { Context } from "cordis";
import { BlueprintRepository } from "../../blueprint/repository.js";

/**
 * blueprint 插件（P7a）：蓝图仓库上架 ctx.blueprint。
 *
 * - blueprintRepository 是进程单例（原 bootstrap.ts ApiContext 的
 *   `new BlueprintRepository()` 同一构造，只换实例来源，行为零变化）；
 * - inject 为空：repository 自给自足（路径经 config/paths 模块函数），
 *   不消费任何 ctx 服务；
 * - 模块物理位置不动：blueprint/engine.ts 的 executeBlueprint 被
 *   api/routes/blueprints.ts 库级直 import，口径不变（同 P4 document-store
 *   先例——不进插件面）。
 */
export const name = "blueprint";

/** 无 ctx 服务依赖（见头注） */
export const inject: string[] = [];

/** ctx.blueprint 上架面 */
export interface BlueprintFace {
  /** 蓝图仓库（进程单例，blueprints.jsonl） */
  blueprintRepository: BlueprintRepository;
}

declare module "cordis" {
  interface Context {
    /** 蓝图面（见 BlueprintFace） */
    blueprint: BlueprintFace;
  }
}

export function apply(ctx: Context): void {
  ctx.provide("blueprint", {
    blueprintRepository: new BlueprintRepository(),
  } satisfies BlueprintFace);
}

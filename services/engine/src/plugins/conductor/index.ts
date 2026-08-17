import type { Context } from "cordis";
import { SessionRepository } from "../../conductor/repository.js";

/**
 * conductor 插件（P7a）：群聊会话仓库上架 ctx.conductor。
 *
 * - sessionRepository 是进程单例（原 bootstrap.ts ApiContext 的
 *   `new SessionRepository()` 同一构造，只换实例来源，行为零变化）；
 * - inject 为空：repository 自给自足（路径经 config/paths 模块函数），
 *   不消费任何 ctx 服务；
 * - 模块物理位置不动：conductor/conductor.ts 的群聊 @mention 路由纯函数
 *   被 ws/session-handler 等库级直 import，口径不变（同 P4 document-store
 *   先例——不进插件面）。
 */
export const name = "conductor";

/** 无 ctx 服务依赖（见头注） */
export const inject: string[] = [];

/** ctx.conductor 上架面 */
export interface ConductorFace {
  /** 群聊会话仓库（进程单例，sessions.jsonl） */
  sessionRepository: SessionRepository;
}

declare module "cordis" {
  interface Context {
    /** 群聊会话面（见 ConductorFace） */
    conductor: ConductorFace;
  }
}

export function apply(ctx: Context): void {
  ctx.provide("conductor", {
    sessionRepository: new SessionRepository(),
  } satisfies ConductorFace);
}

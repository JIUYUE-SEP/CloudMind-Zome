import type { Context } from "cordis";
import {
  loadSoul,
  loadMindChunks,
  retrieveMindChunks,
  ensureMindFiles,
  appendMindExperiences,
} from "../../mind/mind-files.js";
import { isInjectionSuspect } from "../../mind/injection-filter.js";

/**
 * mind 插件（P4）：灵魂层独立面上架 ctx.mind（SOUL.md/MIND.md 人格文件 +
 * 注入检测过滤器）。mind/mind-files.ts 与 mind/injection-filter.ts 物理位置
 * 不动，本文件作挂载面。
 *
 * mind→memory(document-store) 为批准保留的库级直 import（单向，mind-files.ts:5）；
 * 反向 memory→mind 的值边本期已切（compression-task 改构造注入，见
 * memory/topic/compression-task.ts 头注）。
 */
export const name = "mind";

/** 无 ctx 服务依赖（document-store 为库级直 import，非 ctx 服务） */
export const inject: string[] = [];

/** ctx.mind 上架面：灵魂层函数汇集（模块函数本无状态，面即模块） */
export interface MindService {
  loadSoul: typeof loadSoul;
  loadMindChunks: typeof loadMindChunks;
  retrieveMindChunks: typeof retrieveMindChunks;
  ensureMindFiles: typeof ensureMindFiles;
  appendMindExperiences: typeof appendMindExperiences;
  isInjectionSuspect: typeof isInjectionSuspect;
}

declare module "cordis" {
  interface Context {
    /** 灵魂层服务面（SOUL/MIND 人格文件 + 注入检测，见 MindService） */
    mind: MindService;
  }
}

/** 服务面对象本体：导出供测试与直构造路径（worker 单测等）复用 */
export const mindService: MindService = {
  loadSoul,
  loadMindChunks,
  retrieveMindChunks,
  ensureMindFiles,
  appendMindExperiences,
  isInjectionSuspect,
};

// P6 收口：MindChunk 类型经本面再导出——core/agent-worker 的 mind/ 类型边
// 统一收束到插件挂载面（type-only，P4 遗留清单 P6 项）
export type { MindChunk } from "../../mind/mind-files.js";

export function apply(ctx: Context): void {
  ctx.provide("mind", mindService);
}

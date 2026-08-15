import type { Context } from "cordis";
import { resolveContextWindow } from "../../compute/context-window.js";
import { aggregateUsage } from "../../compute/usage.js";

/**
 * compute 插件（P5）：算力解析面上架 ctx.compute。
 *
 * - resolveContextWindow（W 查找链：型号表 contextWindow → agent 显式
 *   maxContextTokens → 80_000）与 aggregateUsage（llm_calls 用量聚合）
 *   均保持原签名原语义——面是模块函数汇集，不包装。
 * - inject: ["config"] 的语义：W 查找链以 ConfigRepository 为域依赖
 *   （型号表/回退链从 config.json 读）——声明排序，配置就绪后再激活，
 *   cordis PENDING 语义替代手工序；面本身保持 repo 由调用方传入的原签名。
 */
export const name = "compute";

/** W 查找链读 ConfigRepository（见头注） */
export const inject = ["config"];

/** ctx.compute 上架面 */
export interface ComputeFace {
  /** W 查找链（原 compute/context-window.ts:57 原签名原语义） */
  resolveContextWindow: typeof resolveContextWindow;
  /** 用量聚合（原 compute/usage.ts:199 原签名原语义） */
  aggregateUsage: typeof aggregateUsage;
}

declare module "cordis" {
  interface Context {
    /** 算力解析面（见 ComputeFace） */
    compute: ComputeFace;
  }
}

/** 面对象本体：导出供测试与直构造路径复用（与 mindService 同例） */
export const computeService: ComputeFace = {
  resolveContextWindow,
  aggregateUsage,
};

export function apply(ctx: Context): void {
  ctx.provide("compute", computeService);
}

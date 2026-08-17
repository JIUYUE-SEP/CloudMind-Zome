import type { Context } from "cordis";
import { createContextPipelineForAgent } from "../../core/pipeline-factory.js";

/**
 * pipeline 插件（P5）：上下文管线工厂面上架 ctx.pipeline。
 *
 * - 上架的是**工厂能力**（createContextPipelineForAgent 原签名原语义）——
 *   per-agent 管线实例仍由 worker 创建链按需现造；hotSync 等 worker 侧逻辑
 *   不动（P6）。
 * - context/ 目录物理位置不动（无倒置要解），本文件作挂载面。
 * - token-counter 保持进程单例（context/token-counter.ts:58-63 注释明言防
 *   WASM 泄漏）：不包装不复制，context/ 内部直 import 保留。
 * - L2 @提及层曾为空槽位（声明未接线、无生产者），已随审计 M7 修复整层
 *   删除（context/layers.ts 注释留有恢复指引）。
 */
export const name = "pipeline";

/** 无 ctx 服务依赖（工厂自给自足） */
export const inject: string[] = [];

/** ctx.pipeline 上架面 */
export interface PipelineFactories {
  /** 按 agent 配置创建 ContextPipeline（原 core/pipeline-factory.ts:13 原签名原语义） */
  createContextPipelineForAgent: typeof createContextPipelineForAgent;
}

declare module "cordis" {
  interface Context {
    /** 上下文管线工厂面（见 PipelineFactories） */
    pipeline: PipelineFactories;
  }
}

export function apply(ctx: Context): void {
  ctx.provide("pipeline", { createContextPipelineForAgent } satisfies PipelineFactories);
}

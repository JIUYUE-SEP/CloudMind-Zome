import type { Context } from "cordis";
import { Scheduler } from "../../scheduler/scheduler.js";

/**
 * scheduler 插件（P7c）：定时任务调度器上架 ctx.scheduler。
 *
 * - Scheduler 构造面同期瘦身（迁移方案既定项「入树前先瘦身为 inject 声明」）：
 *   不再吃整个 ApiContext，只声明窄依赖 SchedulerDeps（agentRepository.list
 *   + getAgentWorker，语义与原 ApiContext 同名项一字不差）——两项都来自
 *   agents 面合体单例，与 bootstrap 原接线是同一批实例。
 * - 上架面 = Scheduler 实例本体（最小面）：start/stop 生命周期仍由
 *   bootstrap 在原位置驱动（启动对账之后、createServer 之前 start；关停钩
 *   stop）——apply 内绝不 start，先后序一字不动。
 * - 5s 轮询选项随构造迁入（原 bootstrap `new Scheduler(context,
 *   { pollIntervalMs: 5000 })` 同值）；tick/runTask/error-throttle 行为
 *   不在本期触碰。
 */
export const name = "scheduler";

/** agentRepository / getOrCreateWorker 均来自 agents 面（见头注） */
export const inject = ["agents"];

declare module "cordis" {
  interface Context {
    /** 定时任务调度器实例（start/stop 生命周期见 bootstrap 原位置） */
    scheduler: Scheduler;
  }
}

export function apply(ctx: Context): void {
  const scheduler = new Scheduler(
    {
      agentRepository: ctx.agents.agentRepository,
      getAgentWorker: ctx.agents.getOrCreateWorker,
    },
    { pollIntervalMs: 5000 },
  );
  ctx.provide("scheduler", scheduler);
}

import type { Context } from "cordis";
import { Scheduler } from "../../scheduler/scheduler.js";

/**
 * scheduler 插件（P7c）：定时任务调度器上架 ctx.scheduler。
 *
 * - Scheduler 构造面同期瘦身（迁移方案既定项「入树前先瘦身为 inject 声明」）：
 *   不再吃整个 ApiContext，只声明窄依赖 SchedulerDeps（agentRepository.list
 *   + getAgentWorker，语义与原 ApiContext 同名项一字不差）——两项都来自
 *   agents 面合体单例，与 bootstrap 原接线是同一批实例。
 * - 上架面 = Scheduler 实例本体（最小面）。P9 起 start 生命周期收进本插件：
 *   apply 内监听 engine/ready（@mode serial，声明见 plugins/memory 的
 *   Events 合并）→ scheduler.start()。serial 按注册序等待异步监听，
 *   **注册序 = 插件激活序：memory 先于本插件激活**（bootstrap 挂载序
 *   保证），启动对账完成才起轮询——与原 bootstrap「对账 → scheduler.start()
 *   → createServer」先后序一字不动（顺序依赖同见 plugins/memory 头注）。
 *   stop 面保留给 bootstrap 关停钩。
 * - 5s 轮询选项随构造迁入（原 bootstrap `new Scheduler(context,
 *   { pollIntervalMs: 5000 })` 同值）；tick/runTask/error-throttle 行为
 *   不在本期触碰。
 */
export const name = "scheduler";

/** agentRepository / getOrCreateWorker 均来自 agents 面（见头注） */
export const inject = ["agents"];

declare module "cordis" {
  interface Context {
    /** 定时任务调度器实例（start 由 engine/ready 驱动；stop 由 bootstrap 关停钩驱动） */
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
  // engine/ready → start（P9，见头注顺序依赖）：serial 派发等 memory 的
  // 启动对账监听先落定，对账完成才起轮询
  ctx.on("engine/ready", () => {
    scheduler.start();
  });
}

import { logger } from "../logger.js";
import type { IAgentRepository } from "../memory/repositories/types.js";
import type { AgentWorker } from "../core/agent-worker.js";
import { SchedulerRepository } from "./repository.js";
import { computeNextRun, isDue } from "./engine.js";
import { ErrorThrottle } from "../plugins/log/error-throttle.js";
import type { ScheduledTask } from "./types.js";
import { randomUUID } from "node:crypto";

export interface SchedulerOptions {
  pollIntervalMs?: number;
  /** 测试注入带假时钟的节流器（生产缺省） */
  errorThrottle?: ErrorThrottle;
}

/**
 * Scheduler 实际消费的窄依赖（P7c 构造瘦身：不再吃整个 ApiContext）——
 * 只用 agentRepository.list() 扫全量 agent + getAgentWorker 解析 worker，
 * 两字段语义与原 ApiContext 同名项一字不差。
 */
export interface SchedulerDeps {
  agentRepository: IAgentRepository;
  getAgentWorker(agentId: string): Promise<AgentWorker | undefined>;
}

/** 错误指纹：消息前 120 字符足够区分原因，又不因长栈/长输出稀释 key */
function errKey(err: unknown): string {
  return String(err).slice(0, 120);
}

/** M27：任务失败后一次性重试的延迟（与 cron 周期解耦，分钟级补偿即可） */
const RETRY_DELAY_MS = 60_000;

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private runningTick = false;
  private runningTasks = new Set<string>();
  /** M27：已用掉一次性重试额度的任务（内存态；进程重启视为新一轮，重新获得一次额度） */
  private retriedTasks = new Set<string>();
  /** P4-4：tick/任务错误节流（同 key 退避记录+计数+恢复，不每秒刷屏） */
  private readonly errors: ErrorThrottle;

  constructor(private deps: SchedulerDeps, private options: SchedulerOptions = {}) {
    this.errors = options.errorThrottle ?? new ErrorThrottle();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => this.tick(), interval);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.runningTick) return;
    this.runningTick = true;
    try {
      const agents = await this.deps.agentRepository.list();
      for (const agent of agents) {
        const repo = new SchedulerRepository(agent.id);
        const tasks = await repo.list();
        for (const task of tasks) {
          if (!task.enabled) continue;
          if (!task.nextRunAt || isDue(task.nextRunAt)) {
            // Fire and forget: a slow task must not block the global tick.
            this.runTask(task, agent.id).catch((err) => {
              this.logThrottled("error", `task:${task.id}:${errKey(err)}`, { err }, `scheduled task ${task.id} failed`);
            });
          }
        }
      }
      // tick 整体成功：此前 tick 级错误视为恢复（节流不吞信息）
      for (const { key, hit } of this.errors.recoverPrefix("tick:")) {
        logger.info({ key, count: hit.count, suppressed: hit.suppressed }, "scheduler tick 已恢复");
      }
    } catch (err) {
      this.logThrottled("error", `tick:${errKey(err)}`, { err }, "scheduler tick failed");
    } finally {
      this.runningTick = false;
    }
  }

  /** 节流记录：退避窗口内只计数；窗口到时一条日志带累计（P4-4） */
  private logThrottled(
    level: "error" | "warn",
    key: string,
    fields: Record<string, unknown>,
    msg: string,
  ): void {
    const hit = this.errors.hit(key);
    if (!hit) return;
    logger[level]({ ...fields, throttleKey: key, count: hit.count, suppressed: hit.suppressed }, msg);
  }

  private async runTask(task: ScheduledTask, agentId: string): Promise<void> {
    if (this.runningTasks.has(task.id)) return;
    this.runningTasks.add(task.id);
    // repo 提升到 try 外：catch 里的失败补偿（M27 重试排程）也要用它落盘
    const repo = new SchedulerRepository(agentId);
    try {
      // Advance schedule before execution so a long-running job does not pile
      // up duplicate triggers while it is still in progress.
      task.lastRunAt = new Date().toISOString();
      task.nextRunAt = computeNextRun(task.cron);
      if (!task.nextRunAt) {
        // cron 已失效（如文件被手改）：禁用任务，而不是每个轮询周期都触发一次
        task.enabled = false;
        logger.error(`scheduled task ${task.id} has invalid cron '${task.cron}', disabling it`);
      }
      await repo.update(task);

      const worker = await this.deps.getAgentWorker(agentId);
      if (!worker) return;

      await worker.runScheduledTask({
        id: task.id,
        messages: [
          {
            id: `sched_${Date.now()}_${randomUUID().slice(0, 8)}`,
            role: "user",
            content: [{ type: "text", text: task.prompt }],
            createdAt: new Date().toISOString(),
          },
        ],
        sessionId: task.id,
        onEvent: () => {},
      });
      // 任务跑通：此前该任务的错误视为恢复
      for (const { key, hit } of this.errors.recoverPrefix(`task:${task.id}:`)) {
        logger.info({ key, count: hit.count, suppressed: hit.suppressed }, `scheduled task ${task.id} 已恢复`);
      }
      // M27：跑通即重置一次性重试额度（下个周期失败仍可补跑一次）
      this.retriedTasks.delete(task.id);
    } catch (err) {
      this.logThrottled("error", `task:${task.id}:${errKey(err)}`, { err }, `failed to run scheduled task ${task.id}`);
      // M27 失败补偿：nextRunAt 已在执行前推进，失败会让本次触发静默丢失。
      // 兜底语义 = 一次性重试：把 nextRunAt 改到 RETRY_DELAY_MS 后补跑一次；
      // 仍失败则放弃本次触发、等下个 cron 周期，不无限重试。enabled=false
      // （cron 已失效被禁用）的任务不重试。
      if (task.enabled && !this.retriedTasks.has(task.id)) {
        this.retriedTasks.add(task.id);
        try {
          task.nextRunAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
          await repo.update(task);
          logger.warn({ taskId: task.id, nextRunAt: task.nextRunAt }, `scheduled task ${task.id} failed, retrying once at ${task.nextRunAt}`);
        } catch (updateErr) {
          // 重试排程落盘失败只记 warn——主错误已记录，不掩盖
          logger.warn({ err: updateErr, taskId: task.id }, `scheduled task ${task.id} retry schedule persist failed`);
        }
      } else if (this.retriedTasks.has(task.id)) {
        // 重试也失败：清掉额度标记，下次 cron 周期失败可再获一次重试
        this.retriedTasks.delete(task.id);
      }
    } finally {
      this.runningTasks.delete(task.id);
    }
  }
}

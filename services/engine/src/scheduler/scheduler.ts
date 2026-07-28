import { logger } from "../logger.js";
import type { ApiContext } from "../api/context.js";
import { SchedulerRepository } from "./repository.js";
import { computeNextRun, isDue } from "./engine.js";
import { ErrorThrottle } from "./error-throttle.js";
import type { ScheduledTask } from "./types.js";

export interface SchedulerOptions {
  pollIntervalMs?: number;
  /** 测试注入带假时钟的节流器（生产缺省） */
  errorThrottle?: ErrorThrottle;
}

/** 错误指纹：消息前 120 字符足够区分原因，又不因长栈/长输出稀释 key */
function errKey(err: unknown): string {
  return String(err).slice(0, 120);
}

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private runningTick = false;
  private runningTasks = new Set<string>();
  /** P4-4：tick/任务错误节流（同 key 退避记录+计数+恢复，不每秒刷屏） */
  private readonly errors: ErrorThrottle;

  constructor(private context: ApiContext, private options: SchedulerOptions = {}) {
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
      const agents = await this.context.agentRepository.list();
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
    try {
      const repo = new SchedulerRepository(agentId);
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

      const worker = await this.context.getAgentWorker(agentId);
      if (!worker) return;

      await worker.runScheduledTask({
        id: task.id,
        messages: [
          {
            id: `sched_${Date.now()}`,
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
    } catch (err) {
      this.logThrottled("error", `task:${task.id}:${errKey(err)}`, { err }, `failed to run scheduled task ${task.id}`);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }
}

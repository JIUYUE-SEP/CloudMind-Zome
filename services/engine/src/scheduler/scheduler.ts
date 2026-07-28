import { logger } from "../logger.js";
import type { ApiContext } from "../api/context.js";
import { SchedulerRepository } from "./repository.js";
import { computeNextRun, isDue } from "./engine.js";
import type { ScheduledTask } from "./types.js";

export interface SchedulerOptions {
  pollIntervalMs?: number;
}

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private runningTick = false;
  private runningTasks = new Set<string>();

  constructor(private context: ApiContext, private options: SchedulerOptions = {}) {}

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
              logger.error({ err: err }, `scheduled task ${task.id} failed`);
            });
          }
        }
      }
    } catch (err) {
      logger.error({ err: err }, "scheduler tick failed");
    } finally {
      this.runningTick = false;
    }
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
    } catch (err) {
      logger.error({ err: err }, `failed to run scheduled task ${task.id}`);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }
}

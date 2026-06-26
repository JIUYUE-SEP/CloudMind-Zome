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
            await this.runTask(task, agent.id);
          }
        }
      }
    } finally {
      this.runningTick = false;
    }
  }

  private async runTask(task: ScheduledTask, agentId: string): Promise<void> {
    const worker = await this.context.getAgentWorker(agentId);
    if (!worker) return;

    worker.enqueue({
      id: task.id,
      messages: [
        {
          id: `sched_${Date.now()}`,
          role: "user",
          content: [{ type: "text", text: task.prompt }],
          createdAt: new Date().toISOString(),
        },
      ],
      onEvent: () => {},
    });

    const repo = new SchedulerRepository(agentId);
    task.lastRunAt = new Date().toISOString();
    task.nextRunAt = computeNextRun(task.cron);
    await repo.update(task);
  }
}

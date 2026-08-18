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
      if (!worker) {
        // agent 在 tick 的 list→get 窗口内被删（窄窗口）：本次触发落空。
        // 原本静默 return 无任何痕迹，补 warn 便于排查"任务到点没跑"类问题
        logger.warn({ taskId: task.id, agentId }, `scheduled task ${task.id} dropped: agent ${agentId} worker not found`);
        return;
      }

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
        // F5：执行期结果回调——runScheduledTask 落盘后入队即返回，LLM/provider
        // 等执行期失败只经此回调暴露。失败走与入队期 catch 同一套 M27 补偿
        // （一次性 60s 重试额度），执行成功才重置额度。
        // 防环：补偿只是内存态一次性额度（retriedTasks）。onDone 失败排程的补跑
        // 若再失败，额度已耗尽，不再派生新补偿——链式重试天然有界（≤1 次）。
        // 额度绝不能在入队成功时重置：补跑自身的入队成功会提前归还额度，
        // 持续失败的任务将每 60s 自我续期一次，变相无限重试。
        onDone: (err) => {
          if (err) {
            this.logThrottled("error", `task:${task.id}:${errKey(err)}`, { err }, `scheduled task ${task.id} execution failed`);
            // scheduleRetryOnce 内部已兜住落盘错误（只记 warn），不会 reject
            void this.scheduleRetryOnce(task, repo);
          } else {
            this.handleTaskSuccess(task);
          }
        },
      });
    } catch (err) {
      this.logThrottled("error", `task:${task.id}:${errKey(err)}`, { err }, `failed to run scheduled task ${task.id}`);
      // 入队期失败补偿（M27），与执行期 onDone 失败共用同一套一次性重试
      await this.scheduleRetryOnce(task, repo);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * 任务真正跑通（入队且执行成功）：该任务的节流错误视为恢复（节流不吞信息），
   * 并重置 M27 一次性重试额度（下个周期失败仍可补跑一次）。
   * 注意调用时机只能是 onDone 成功路径，不能是入队成功（防环论证见上方 onDone 注）。
   */
  private handleTaskSuccess(task: ScheduledTask): void {
    for (const { key, hit } of this.errors.recoverPrefix(`task:${task.id}:`)) {
      logger.info({ key, count: hit.count, suppressed: hit.suppressed }, `scheduled task ${task.id} 已恢复`);
    }
    this.retriedTasks.delete(task.id);
  }

  /**
   * M27 失败补偿（入队期 catch 与执行期 onDone 共用）：nextRunAt 已在执行前
   * 推进，失败会让本次触发静默丢失。兜底语义 = 一次性重试：把 nextRunAt 改到
   * RETRY_DELAY_MS 后补跑一次；仍失败则放弃本次触发、等下个 cron 周期，不无限
   * 重试。enabled=false（cron 已失效被禁用）的任务不重试。
   * 重试排程落盘失败只记 warn——主错误已记录，不掩盖；本方法不向外抛错。
   */
  private async scheduleRetryOnce(task: ScheduledTask, repo: SchedulerRepository): Promise<void> {
    if (task.enabled && !this.retriedTasks.has(task.id)) {
      this.retriedTasks.add(task.id);
      try {
        task.nextRunAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
        await repo.update(task);
        logger.warn({ taskId: task.id, nextRunAt: task.nextRunAt }, `scheduled task ${task.id} failed, retrying once at ${task.nextRunAt}`);
      } catch (updateErr) {
        logger.warn({ err: updateErr, taskId: task.id }, `scheduled task ${task.id} retry schedule persist failed`);
      }
    } else if (this.retriedTasks.has(task.id)) {
      // 重试也失败：清掉额度标记，下次 cron 周期失败可再获一次重试
      this.retriedTasks.delete(task.id);
    }
  }
}

/**
 * Swarm 调度核（kimi `session/swarm/agentRunBatch.ts` 适配移植）：
 * burst-then-throttle 发射坡道 + provider 限流恢复环，驱动每次尝试经
 * `AgentRunBatchLauncher` 执行，限流回队经 `suspended` 上浮。纯调度逻辑，
 * 不持有任何 agent/会话状态。
 *
 * 相对 kimi 的适配：
 * - `isProviderRateLimitError` 换本地 429 判定（与 provider/classify.ts 的
 *   isRetryableError 同源——那里把 429 归入"可重试"，这里需要 429 专属判定
 *   驱动容量衰减）；
 * - `retry` npm 包换 ~5 行等价退避（minTimeout × factor^n，不随机抖动——
 *   只此一处使用，不值得为一个公式引依赖）；
 * - `SessionSwarmTask/RunResult` 类型本地定义等价物（去掉 profile/binding/
 *   usage 等 CMZ 全傀儡场景用不到的维度；kind:"resume" 形状保留，阶段 4 启用）；
 * - 用户取消判定：CMZ 无 UserCancellationError 类，按 AbortError 名字判定。
 */
import { logger } from "../logger.js";

export interface SwarmTask {
  /** "resume" 形状保留（阶段 4 resume_agent_ids 启用）；首版全部为 spawn */
  readonly kind?: "spawn" | "resume";
  readonly resumeAgentId?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly swarmItem?: string;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

export interface SwarmRunResult {
  readonly task: SwarmTask;
  readonly agentId?: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly state?: "started" | "not_started";
  readonly result?: string;
  readonly error?: string;
}

export interface SwarmAttemptOptions {
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
}

export interface SwarmSpawnAttemptOptions extends SwarmAttemptOptions {
  readonly swarmItem?: string;
}

export type SwarmAttemptHandle = {
  readonly agentId: string;
  readonly completion: Promise<string>;
};

export type SwarmSuspendedEvent = {
  readonly task: SwarmTask;
  readonly agentId: string;
  readonly reason: string;
};

/** Launcher 四方法形状保留；首版 resume 可与 retry 同实现（傀儡无状态，续跑=同简报重跑） */
export type AgentRunBatchLauncher = {
  spawn(options: SwarmSpawnAttemptOptions): Promise<SwarmAttemptHandle>;
  resume(agentId: string, options: SwarmAttemptOptions): Promise<SwarmAttemptHandle>;
  retry(agentId: string, options: SwarmAttemptOptions): Promise<SwarmAttemptHandle>;
  suspended?(event: SwarmSuspendedEvent): void;
};

/** 429 专属判定（驱动限流模式与容量衰减；其他可重试错误不进此路径） */
function isProviderRateLimitError(error: unknown): boolean {
  const record = error as Record<string, unknown> | null;
  const status = record?.["status"] ?? record?.["statusCode"];
  if (typeof status === "number") return status === 429;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /rate.?limit|too many requests|\b429\b/.test(message);
}

/** CMZ 无 UserCancellationError 类，按 AbortError 名字判定用户取消 */
function isUserCancellation(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

// 常量沿用 kimi：burst 5 连发、700ms 坡道、限流重试 3s×2^n、
// 容量衰减每 2s 减 1 下限 1、3 分钟恢复 +1
const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 3 * 60 * 1000;
const RATE_LIMIT_SUSPENDED_REASON = "Provider rate limit; subagent requeued for retry.";

const AGENT_SWARM_MAX_CONCURRENCY_ENV = "ZOME_SWARM_MAX_CONCURRENCY";

/** retry.createTimeout 等价：minTimeout × factor^attempts（不随机抖动） */
function rateLimitRetryDelayMs(attempt: number): number {
  return RATE_LIMIT_RETRY_BASE_MS * Math.pow(RATE_LIMIT_RETRY_FACTOR, Math.max(0, attempt));
}

type RateLimitedOutcome = {
  readonly type: "rate_limited";
  readonly agentId: string;
  readonly error: string;
};

type AttemptOutcome = SwarmRunResult | RateLimitedOutcome;

type TaskState = {
  readonly index: number;
  readonly task: SwarmTask;
  agentId?: string;
  retryAgentId?: string;
  retryCount: number;
  retryReadyAt: number;
  started: boolean;
};

type ActiveAttempt = {
  readonly state: TaskState;
  readonly controller: AbortController;
  cleanup: () => void;
  ready: boolean;
  timedOut: boolean;
};

export type AgentRunBatchOptions = {
  readonly maxConcurrency?: number;
};

export class AgentRunBatch {
  private readonly states: TaskState[];
  private readonly pending: TaskState[];
  private readonly results: Array<SwarmRunResult | undefined>;
  private readonly active = new Set<ActiveAttempt>();
  private readonly controller = new AbortController();
  private readonly batchSignal: AbortSignal | undefined;
  private readonly batchAbortListener: () => void;
  private readonly maxConcurrency: number | undefined;
  private normalLaunchCount = 0;
  private normalLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private resolve: ((results: SwarmRunResult[]) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private finished = false;
  private started = false;
  private rateLimitMode = false;
  private startedSuccessCount = 0;
  private rateLimitCapacity = 1;
  private lastRateLimitAt: number | undefined;
  private lastCapacityShrinkAt: number | undefined;
  private lastCapacityRecoveryAt: number | undefined;
  private globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
  private nextRateLimitLaunchAt = 0;

  constructor(
    private readonly launcher: AgentRunBatchLauncher,
    tasks: readonly SwarmTask[],
    options: AgentRunBatchOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency;
    this.states = tasks.map((task, index) => ({
      index,
      task,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
    }));
    this.pending = [...this.states];
    this.results = Array.from({ length: tasks.length });
    this.batchSignal = tasks.find((task) => task.signal !== undefined)?.signal;
    this.batchAbortListener = () => {
      this.controller.abort(this.batchSignal?.reason);
      if (isUserCancellation(this.batchSignal?.reason)) {
        this.finishWithUserCancellation();
      } else {
        this.fail(this.batchSignal?.reason ?? new Error("Aborted"));
      }
    };
  }

  run(): Promise<SwarmRunResult[]> {
    if (this.started) {
      throw new Error("AgentRunBatch.run() can only be called once.");
    }
    this.started = true;

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      if (this.states.length === 0) {
        this.finish([]);
        return;
      }

      if (this.batchSignal?.aborted === true) {
        this.batchAbortListener();
        return;
      }

      this.batchSignal?.addEventListener("abort", this.batchAbortListener, { once: true });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.finished) return;
    if (this.finishIfComplete()) return;
    if (this.controller.signal.aborted) return;

    if (this.rateLimitMode) {
      this.scheduleRateLimitLaunch();
    } else {
      this.scheduleNormalLaunch();
    }
  }

  private scheduleNormalLaunch(): void {
    while (
      this.normalLaunchCount < INITIAL_LAUNCH_LIMIT &&
      this.pending.length > 0 &&
      !this.rateLimitMode &&
      !this.isAtConcurrencyLimit()
    ) {
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
    }

    if (
      this.pending.length === 0 ||
      this.rateLimitMode ||
      this.normalLaunchTimer !== undefined ||
      this.isAtConcurrencyLimit()
    ) {
      return;
    }

    this.normalLaunchTimer = setTimeout(() => {
      this.normalLaunchTimer = undefined;
      if (this.finished || this.rateLimitMode || this.pending.length === 0) return;
      if (this.isAtConcurrencyLimit()) return;
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
      this.schedule();
    }, INITIAL_LAUNCH_INTERVAL_MS);
  }

  private isAtConcurrencyLimit(): boolean {
    return this.maxConcurrency !== undefined && this.active.size >= this.maxConcurrency;
  }

  private scheduleRateLimitLaunch(): void {
    this.clearRateLimitTimer();
    if (this.pending.length === 0) return;

    const now = Date.now();
    this.recoverRateLimitCapacity(now);
    if (this.active.size >= this.rateLimitCapacity) {
      this.scheduleRateLimitWakeup(this.nextRateLimitCapacityRecoveryAt(), now);
      return;
    }

    const nextAllowedAt = Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt());
    const nextWakeupAt = Math.min(nextAllowedAt, this.nextRateLimitCapacityRecoveryAt());
    if (nextWakeupAt > now) {
      this.scheduleRateLimitWakeup(nextWakeupAt, now);
      return;
    }

    const pendingIndex = this.pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex === -1) return;

    const [state] = this.pending.splice(pendingIndex, 1);
    this.startAttempt(state!);
    this.nextRateLimitLaunchAt = now + this.globalRetryIntervalMs;
    this.scheduleNextRateLimitWakeup(now);
  }

  private startAttempt(state: TaskState): void {
    if (this.finished || this.controller.signal.aborted) return;

    const attempt: ActiveAttempt = {
      state,
      controller: new AbortController(),
      cleanup: () => {},
      ready: false,
      timedOut: false,
    };
    attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
    this.active.add(attempt);

    this.runAttempt(attempt).then(
      (outcome) => {
        this.handleAttemptOutcome(attempt, outcome);
      },
      (error) => {
        this.handleAttemptError(attempt, error);
      },
    );
  }

  private async runAttempt(attempt: ActiveAttempt): Promise<AttemptOutcome> {
    const task = attempt.state.task;
    const runOptions: SwarmAttemptOptions = {
      prompt: task.prompt,
      description: task.description,
      swarmIndex: task.swarmIndex,
      signal: attempt.controller.signal,
      onReady: () => {
        this.markAttemptReady(attempt);
      },
    };

    let handle: SwarmAttemptHandle;
    try {
      attempt.controller.signal.throwIfAborted();
      if (attempt.state.retryAgentId !== undefined) {
        handle = await this.launcher.retry(attempt.state.retryAgentId, runOptions);
      } else if (task.kind === "resume" && task.resumeAgentId !== undefined) {
        handle = await this.launcher.resume(task.resumeAgentId, runOptions);
      } else {
        const spawnOptions: SwarmSpawnAttemptOptions = {
          swarmItem: task.swarmItem,
          ...runOptions,
        };
        handle = await this.launcher.spawn(spawnOptions);
      }
    } catch (error) {
      return this.failedAttemptOutcome(attempt, error);
    }

    attempt.state.agentId = handle.agentId;
    try {
      const result = await handle.completion;
      return {
        task,
        agentId: handle.agentId,
        status: "completed",
        result,
      };
    } catch (error) {
      if (isProviderRateLimitError(error)) {
        return {
          type: "rate_limited",
          agentId: handle.agentId,
          error: this.attemptErrorMessage(attempt, error, "failed"),
        };
      }

      return this.failedAttemptOutcome(attempt, error);
    }
  }

  private failedAttemptOutcome(attempt: ActiveAttempt, error: unknown): SwarmRunResult {
    const status =
      attempt.controller.signal.aborted && isUserCancellation(attempt.controller.signal.reason)
        ? "aborted"
        : "failed";
    return {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status,
      state: attempt.state.agentId === undefined ? "not_started" : "started",
      error: this.attemptErrorMessage(attempt, error, status),
    };
  }

  private markAttemptReady(attempt: ActiveAttempt): void {
    if (this.finished || attempt.ready || !this.active.has(attempt)) return;

    attempt.ready = true;
    attempt.state.started = true;
    if (!this.rateLimitMode) {
      this.startedSuccessCount += 1;
    }

    if (this.rateLimitMode) {
      this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
      this.nextRateLimitLaunchAt = Date.now() + this.globalRetryIntervalMs;
      this.schedule();
    }
  }

  private handleAttemptOutcome(attempt: ActiveAttempt, outcome: AttemptOutcome): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;

    if ("status" in outcome) {
      this.results[attempt.state.index] = outcome;
    } else if (this.isOnlyUnfinishedTask(attempt.state)) {
      // 最后一个任务不重排：限流也直接 failed（避免无限续跑拖住整批）
      this.results[attempt.state.index] = {
        task: attempt.state.task,
        agentId: outcome.agentId,
        status: "failed",
        state: "started",
        error: outcome.error,
      };
    } else {
      this.requeueRateLimited(attempt, outcome.agentId);
    }
    this.schedule();
  }

  private handleAttemptError(attempt: ActiveAttempt, error: unknown): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;
    this.results[attempt.state.index] = {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    this.schedule();
  }

  private releaseAttempt(attempt: ActiveAttempt): boolean {
    if (!this.active.delete(attempt)) return false;
    attempt.cleanup();
    return true;
  }

  private requeueRateLimited(attempt: ActiveAttempt, agentId: string): void {
    const state = attempt.state;
    state.agentId = agentId;
    state.retryAgentId = agentId;
    this.launcher.suspended?.({
      task: state.task,
      agentId,
      reason: RATE_LIMIT_SUSPENDED_REASON,
    });

    const now = Date.now();
    this.lastRateLimitAt = now;
    state.retryCount += 1;
    const retryDelay = rateLimitRetryDelayMs(state.retryCount - 1);
    state.retryReadyAt = now + retryDelay;
    this.pending.unshift(state);
    this.enterRateLimitMode(now);

    if (!attempt.ready) {
      this.globalRetryIntervalMs = Math.max(this.globalRetryIntervalMs * 2, retryDelay);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + this.globalRetryIntervalMs,
      );
    } else {
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
    }
  }

  private enterRateLimitMode(now: number): void {
    if (!this.rateLimitMode) {
      this.rateLimitMode = true;
      this.clearNormalTimer();
      this.rateLimitCapacity = Math.max(1, this.startedSuccessCount);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
      this.shrinkRateLimitCapacity(now, true);
      return;
    }

    this.shrinkRateLimitCapacity(now, false);
  }

  private shrinkRateLimitCapacity(now: number, force: boolean): void {
    if (
      !force &&
      this.lastCapacityShrinkAt !== undefined &&
      now - this.lastCapacityShrinkAt < RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
    ) {
      return;
    }

    this.rateLimitCapacity = Math.max(1, this.rateLimitCapacity - 1);
    this.lastCapacityShrinkAt = now;
  }

  private recoverRateLimitCapacity(now: number): void {
    const nextRecoveryAt = this.nextRateLimitCapacityRecoveryAt();
    if (nextRecoveryAt > now) return;

    this.rateLimitCapacity += 1;
    this.lastCapacityRecoveryAt = now;
    this.nextRateLimitLaunchAt = Math.min(this.nextRateLimitLaunchAt, now);
  }

  private nextRateLimitCapacityRecoveryAt(): number {
    if (this.pending.length === 0 || this.lastRateLimitAt === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    const latestCapacityChangeAt = Math.max(this.lastRateLimitAt, this.lastCapacityRecoveryAt ?? 0);
    return latestCapacityChangeAt + RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
  }

  private scheduleRateLimitWakeup(wakeupAt: number, now: number): void {
    if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return;
    this.rateLimitLaunchTimer = setTimeout(() => {
      this.rateLimitLaunchTimer = undefined;
      this.schedule();
    }, wakeupAt - now);
  }

  private scheduleNextRateLimitWakeup(now: number): void {
    if (this.pending.length === 0) return;

    const nextWakeupAt =
      this.active.size >= this.rateLimitCapacity
        ? this.nextRateLimitCapacityRecoveryAt()
        : Math.min(
            Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt()),
            this.nextRateLimitCapacityRecoveryAt(),
          );

    this.scheduleRateLimitWakeup(nextWakeupAt, now);
  }

  private nextPendingReadyAt(): number {
    return this.pending.reduce((nextAt, state) => {
      return Math.min(nextAt, state.retryReadyAt);
    }, Number.POSITIVE_INFINITY);
  }

  private finishIfComplete(): boolean {
    if (this.results.every((result) => result !== undefined)) {
      this.finish(this.results);
      return true;
    }
    return false;
  }

  private isOnlyUnfinishedTask(state: TaskState): boolean {
    return this.results.every((result, index) => index === state.index || result !== undefined);
  }

  private finishWithUserCancellation(): void {
    if (this.finished) return;

    this.finish(
      this.states.map((state) => {
        const result = this.results[state.index];
        if (result !== undefined) return result;

        if (state.started || state.agentId !== undefined) {
          return {
            task: state.task,
            agentId: state.agentId,
            status: "aborted" as const,
            state: "started" as const,
            error:
              "The user manually interrupted this subagent batch before this subagent finished.",
          };
        }

        return {
          task: state.task,
          status: "aborted" as const,
          state: "not_started" as const,
          error:
            "The user manually interrupted this subagent batch before this subagent was started.",
        };
      }),
    );
  }

  private finish(results: SwarmRunResult[]): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.resolve?.(results);
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.reject?.(error);
  }

  private cleanup(): void {
    this.batchSignal?.removeEventListener("abort", this.batchAbortListener);
    this.clearNormalTimer();
    this.clearRateLimitTimer();
    for (const attempt of this.active.values()) {
      attempt.cleanup();
    }
    this.active.clear();
  }

  private clearNormalTimer(): void {
    if (this.normalLaunchTimer !== undefined) clearTimeout(this.normalLaunchTimer);
    this.normalLaunchTimer = undefined;
  }

  private clearRateLimitTimer(): void {
    if (this.rateLimitLaunchTimer !== undefined) clearTimeout(this.rateLimitLaunchTimer);
    this.rateLimitLaunchTimer = undefined;
  }

  private linkAttemptSignals(attempt: ActiveAttempt, task: SwarmTask): () => void {
    const abortFromBatch = () => {
      attempt.controller.abort(this.controller.signal.reason);
    };
    const abortFromTask = () => {
      attempt.controller.abort(task.signal?.reason);
    };
    const timeout =
      task.timeout === undefined
        ? undefined
        : setTimeout(() => {
            attempt.timedOut = true;
            attempt.controller.abort(new Error("Aborted"));
          }, task.timeout);

    if (this.controller.signal.aborted) {
      abortFromBatch();
    } else if (task.signal?.aborted === true) {
      abortFromTask();
    } else {
      this.controller.signal.addEventListener("abort", abortFromBatch, { once: true });
      task.signal?.addEventListener("abort", abortFromTask, { once: true });
    }

    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      this.controller.signal.removeEventListener("abort", abortFromBatch);
      task.signal?.removeEventListener("abort", abortFromTask);
    };
  }

  private attemptErrorMessage(
    attempt: ActiveAttempt,
    error: unknown,
    status: SwarmRunResult["status"],
  ): string {
    if (attempt.timedOut && attempt.state.task.timeout !== undefined) {
      return "Subagent timed out.";
    }
    if (status === "aborted") return "The user manually interrupted this subagent batch.";
    return error instanceof Error ? error.message : String(error);
  }
}

/** 并发上限环境变量（桌面场景默认不设=坡道自适应；设置则硬封顶） */
export function resolveSwarmMaxConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  const raw = env[AGENT_SWARM_MAX_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn(`[swarm] ${AGENT_SWARM_MAX_CONCURRENCY_ENV} 非正整数（${JSON.stringify(raw)}），按不设上限处理`);
    return undefined;
  }
  return value;
}

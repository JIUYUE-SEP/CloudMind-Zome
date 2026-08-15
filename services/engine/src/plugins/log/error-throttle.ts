/**
 * 错误节流器（P4-4，体验 review O-M1）：同一错误（同 key）不要每个周期
 * 重复刷屏——bench-agent 刷屏事件即 scheduler tick 每秒一条相同错误。
 *
 * 策略：首次立即记录；之后按 1s → 4s → 16s → … → 5min 封顶指数退避，
 * 退避窗口内只计数不记录；窗口到时记录一条（含发生总数与被折叠条数）。
 * 恢复（对应操作再次成功）时清除并回报累计——节流不吞信息。
 * key 由调用方构造（如 `task:{id}:{错误消息}`），不同错误独立节流。
 */
export interface ThrottleHit {
  /** 该 key 累计发生次数（含本次） */
  count: number;
  /** 自上次记录以来被折叠的条数 */
  suppressed: number;
}

interface Entry {
  count: number;
  suppressed: number;
  nextLogAt: number;
  backoffMs: number;
}

export interface ErrorThrottleOptions {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** 测试注入时钟 */
  now?: () => number;
}

export class ErrorThrottle {
  private entries = new Map<string, Entry>();
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;

  constructor(options: ErrorThrottleOptions = {}) {
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** 一次发生：返回应记录的信息；退避窗口内返回 undefined（只计数） */
  hit(key: string): ThrottleHit | undefined {
    const now = this.now();
    const e = this.entries.get(key);
    if (!e) {
      this.entries.set(key, {
        count: 1,
        suppressed: 0,
        nextLogAt: now + this.initialBackoffMs,
        backoffMs: this.initialBackoffMs,
      });
      return { count: 1, suppressed: 0 };
    }
    e.count++;
    if (now < e.nextLogAt) {
      e.suppressed++;
      return undefined;
    }
    const out = { count: e.count, suppressed: e.suppressed };
    e.suppressed = 0;
    e.backoffMs = Math.min(e.backoffMs * 4, this.maxBackoffMs);
    e.nextLogAt = now + e.backoffMs;
    return out;
  }

  /** 恢复：清除该 key，有记录则返回累计（供调用方记一条"已恢复"） */
  recover(key: string): ThrottleHit | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    return { count: e.count, suppressed: e.suppressed };
  }

  /** 按前缀恢复（如 task:{id}: 下的所有错误原因），返回命中的 key 与累计 */
  recoverPrefix(prefix: string): { key: string; hit: ThrottleHit }[] {
    const out: { key: string; hit: ThrottleHit }[] = [];
    for (const [key, e] of this.entries) {
      if (key.startsWith(prefix)) {
        out.push({ key, hit: { count: e.count, suppressed: e.suppressed } });
        this.entries.delete(key);
      }
    }
    return out;
  }
}

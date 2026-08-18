import { logger } from "../../logger.js";
import type { TopicSegment } from "./types.js";

/**
 * 后台压缩队列：per-agent 串行执行，fire-and-forget 不阻塞对话主流程。
 *
 * M13：单任务失败做进程内有限次退避重试——原"失败仅告警"语义下，LLM
 * 长时间不可用时热存储无界增长直至撞 100MB 读上限。重试参数：最多 3 次，
 * 退避 5s → 15s → 45s（×3 指数，一轮约 65s，覆盖 LLM 短暂抖动/限流窗口）。
 * 重试在 tail 链内完成，队列保持串行：前段退避期间后段不启动（同 agent
 * 的段乱序压缩会错位话题边界）。关停侧不受影响：gracefulShutdown 的 drain
 * 自带超时兜底。日志沿用现 warn 口径：每次重试一条（含次数与退避），上限
 * 4 条/段，不构成刷屏，不引入 ErrorThrottle。
 * 重试耗尽维持原语义：warn 告警、原始消息留热存储、pending 记录保留，
 * 交启动对账（reconcilePendingSegments）兜底，不丢消息。
 */

/** 各次重试前的退避等待（ms）：第 1/2/3 次重试分别等 5s/15s/45s；长度即最大重试次数 */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

export interface CompressionQueueOptions {
  /** 重试退避序列（长度即最大重试次数）；测试注入短延迟 */
  retryDelaysMs?: readonly number[];
  /** 测试注入 sleep（生产为 setTimeout 等待） */
  sleep?: (ms: number) => Promise<void>;
}

export class CompressionQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private run: (segment: TopicSegment) => Promise<void>,
    options: CompressionQueueOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  enqueue(segment: TopicSegment): void {
    this.tail = this.tail
      .then(() => this.runWithRetry(segment))
      .catch((err) => {
        logger.warn(
          { err: err },
          `[topic] 压缩任务重试耗尽（原始消息保留在热存储，交启动对账兜底）：${segment.topicId}`,
        );
      });
  }

  /** 带退避重试的单段执行：重试耗尽后上抛，由 enqueue 统一告警 */
  private async runWithRetry(segment: TopicSegment): Promise<void> {
    const maxAttempts = this.retryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.run(segment);
        return;
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        const delay = this.retryDelaysMs[attempt - 1]!;
        logger.warn(
          { err: err, attempt, maxAttempts, retryInMs: delay },
          `[topic] 压缩任务失败，${delay}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次）：${segment.topicId}`,
        );
        await this.sleep(delay);
      }
    }
  }

  /** 等待队列清空（测试与进程退出前使用；含在途任务的重试） */
  async drain(): Promise<void> {
    await this.tail;
  }
}

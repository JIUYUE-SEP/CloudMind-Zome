import { logger } from "../../logger.js";
import type { TopicSegment } from "./types.js";

/**
 * 后台压缩队列：per-agent 串行执行，fire-and-forget 不阻塞对话主流程。
 * 单个任务失败仅告警（原始消息保留在热存储，不丢失），队列继续。
 */
export class CompressionQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private run: (segment: TopicSegment) => Promise<void>) {}

  enqueue(segment: TopicSegment): void {
    this.tail = this.tail
      .then(() => this.run(segment))
      .catch((err) => {
        logger.warn({ err: err }, `[topic] 压缩任务失败（原始消息保留在热存储）：${segment.topicId}`);
      });
  }

  /** 等待队列清空（测试与进程退出前使用） */
  async drain(): Promise<void> {
    await this.tail;
  }
}

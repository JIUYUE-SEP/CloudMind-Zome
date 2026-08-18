import { logger } from "../logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { IMessageRepository } from "./repositories/types.js";
import { archivedMessageIds, compressedDir } from "./topic/store.js";
import {
  clearTopicState,
  loadTopicState,
  removePendingSegment,
} from "./topic/state.js";
import { runCompressionTask, type CompressionTaskDeps } from "./topic/compression-task.js";

/**
 * 启动对账（Phase 2 review M3 建议的"压缩档 msgIds ∩ 热存储"补归档）。
 *
 * 覆盖的孤儿类型：压缩档已写入、但 archiveAndRemove 未完成的消息——
 * 进程在"写压缩档 → 归档"两步之间退出，或压缩队列在退出时丢弃了未完成项。
 * 这类消息已有 L5 摘要，留在热存储会被 L4 重复检索注入，且永不再被归档。
 *
 * 进程退出时尚在未关闭话题里的消息（开放话题，tracker 状态已按事件落盘到
 * topic-state.json）由本模块的 reconcileOrphanedTopic 处理：真机 #10 设计
 * 定案后，开放话题在启动时**保留不处理**（reconcile 只收尸），由运行时
 * TopicTracker 自然收——详见 reconcileOrphanedTopic 注释。
 *
 * 已存在于 messages_archived.jsonl 的记录不在此去重：归档写（append 循环）
 * 与热存储删除（mutateLines）之间的崩溃窗口极小，重复行只影响"最后防线"
 * 文件体积，读取侧按 id 过滤不受影响。
 *
 * @returns 补归档的消息条数
 */
export async function reconcileHotStorage(
  agentId: string,
  repo: IMessageRepository,
): Promise<number> {
  // 无压缩档时 archivedMessageIds 返回空集，直接跳过（不读热存储）
  const archivedIds = await archivedMessageIds(agentId);
  if (archivedIds.size === 0) return 0;

  // 热存储 ∩ 已归档 = 孤儿（热存储不存在时 getByIds 返回空，自然跳过）
  const orphans = await repo.getByIds([...archivedIds]);
  if (orphans.length === 0) return 0;

  // 复用 archiveAndRemove 的"先写归档再删热存储"原子序，失败不丢消息。
  // 孤儿 createdAt 可能早于归档尾部（崩溃窗口后归档已增长、跨会话归档交错）——
  // 裸 append 会破坏「归档按 createdAt 递增」前提（listBySessionWithArchived /
  // firstUserMessageBySession / recall 的归并读依赖）；有序性由 archiveAndRemove
  // 的保序写入承担（乱序批次流式归并插入，见其实现注释）
  await repo.archiveAndRemove(orphans.map((m) => m.id));
  return orphans.length;
}

/**
 * 启动对账（P1-2 review M6 → 真机 #10 方案 2 精细化）：开放话题**跳过**。
 *
 * 设计定案：重启应该是「她睡一觉」，不是「话题屠杀」。topic-state.json 的
 * open 状态原样保留——不消费、不归档、不调 LLM——留给运行时自然结束：
 * TopicTracker 在阈值（默认 20）/显式切换词/时间窗超时（默认 30min）时收。
 * 幂等：每次启动看到同一个 open 状态都跳过，不累积副作用。
 *
 * 此前 #10 现场：退出时未关闭的话题在重启时被整段强制归档，十几条
 * （未到 messageThreshold）也全量 archiveAndRemove，前端体感「重启=失忆」。
 *
 * @returns 恒 0——开放话题不在启动时处理
 */
export async function reconcileOrphanedTopic(
  agentId: string,
  _repo: IMessageRepository,
  _deps: CompressionTaskDeps,
): Promise<number> {
  // 签名保留（bootstrap 三入口统一传 repo/deps）；跳过路径不使用它们
  void _repo;
  void _deps;
  const state = await loadTopicState(agentId);
  if (!state?.open || state.open.messageIds.length === 0) return 0;
  logger.info(
    `[reconcile] agent=${agentId} 开放话题保留 ${state.open.messageIds.length} 条，留待运行时自然收`,
  );
  return 0;
}

/**
 * 启动对账扩展（P1.5 M-b）：补"已关闭已入队未压缩"的话题段。
 *
 * closeSegment 清空 open、段入压缩队列后，进程在任务执行前退出（强杀路径下
 * shutdown handler 根本不跑），该段两个对账方向都够不着：
 * 无压缩档（reconcileHotStorage 不见）、open 已清（reconcileOrphanedTopic 不见）。
 * M-b 起段入队即记 pending（state.ts），此处按 pending 补漏：
 * - 压缩档已存在（崩溃在"写压缩档 → 归档"之间）：只补归档，不重复压缩；
 * - 压缩档不存在：按 id 从热存储回读正文，走同一 runCompressionTask
 *   （archiveOnly 段不调用 LLM）；正文全部不在热存储（任务已完成、pending
 *   未及清除）时仅清记录。
 * 单段处理成功才清该条 pending；失败上抛（调用方 catch 记 warn），pending
 * 保留，下次启动重试，不丢消息。
 *
 * @returns 补处理的消息条数
 */
export async function reconcilePendingSegments(
  agentId: string,
  repo: IMessageRepository,
  deps: CompressionTaskDeps,
): Promise<number> {
  const state = await loadTopicState(agentId);
  const pending = state?.pending ?? [];
  if (pending.length === 0) return 0;

  let processed = 0;
  for (const seg of pending) {
    if (await hasCompressedTopic(agentId, seg.topicId)) {
      await repo.archiveAndRemove(seg.messageIds);
      processed += seg.messageIds.length;
    } else {
      const messages = await repo.getByIds(seg.messageIds);
      if (messages.length > 0) {
        await runCompressionTask(
          {
            topicId: seg.topicId,
            messages,
            sourceId: seg.sourceId,
            sourceName: seg.sourceName,
            startedAt: seg.startedAt,
            endedAt: seg.endedAt,
            archiveOnly: seg.archiveOnly,
          },
          deps,
        );
        processed += messages.length;
      }
    }
    await removePendingSegment(agentId, seg.topicId);
  }

  // 全部消费完：open 也为空时删状态文件
  const rest = await loadTopicState(agentId);
  if (rest && (rest.pending ?? []).length === 0 && rest.open === null) {
    await clearTopicState(agentId);
  }
  return processed;
}

async function hasCompressedTopic(agentId: string, topicId: string): Promise<boolean> {
  try {
    await fs.access(path.join(compressedDir(agentId), `${topicId}.md`));
    return true;
  } catch {
    return false;
  }
}

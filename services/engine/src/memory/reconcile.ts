import { randomUUID } from "node:crypto";
import type { IMessageRepository } from "./repositories/types.js";
import { archivedMessageIds } from "./topic/store.js";
import { clearTopicState, loadTopicState } from "./topic/state.js";
import { runCompressionTask, type CompressionTaskDeps } from "./topic/compression-task.js";
import { MIN_SEGMENT_MESSAGES, type TopicSegment } from "./topic/types.js";

/**
 * 启动对账（Phase 2 review M3 建议的"压缩档 msgIds ∩ 热存储"补归档）。
 *
 * 覆盖的孤儿类型：压缩档已写入、但 archiveAndRemove 未完成的消息——
 * 进程在"写压缩档 → 归档"两步之间退出，或压缩队列在退出时丢弃了未完成项。
 * 这类消息已有 L5 摘要，留在热存储会被 L4 重复检索注入，且永不再被归档。
 *
 * 另一类孤儿——进程退出时尚在未关闭话题里的消息——由本模块的
 * reconcileOrphanedTopic 覆盖（P1-2：tracker 状态已按事件落盘到
 * topic-state.json，可据此识别并补压缩/归档）。
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

  // 复用 archiveAndRemove 的"先写归档再删热存储"原子序，失败不丢消息
  await repo.archiveAndRemove(orphans.map((m) => m.id));
  return orphans.length;
}

/**
 * 启动对账扩展（P1-2，review M6）：处理 tracker 落盘状态指向的未压缩消息
 * （重启孤儿——进程退出时仍在未关闭话题里的消息）。
 *
 * 按落盘的 messageIds 从热存储回读正文（已不在热存储的自然过滤），重建
 * segment：达到 MIN_SEGMENT_MESSAGES 的走 LLM 补压缩，更短的 archiveOnly
 * 归档——与正常话题关闭走同一 runCompressionTask。
 *
 * 失败语义：压缩/归档异常向调用方抛错（启动流程 catch 记 warn），状态文件
 * 保留、消息留在热存储，下次启动重试，不丢消息。
 *
 * @returns 处理掉的孤儿消息条数
 */
export async function reconcileOrphanedTopic(
  agentId: string,
  repo: IMessageRepository,
  deps: CompressionTaskDeps,
): Promise<number> {
  const state = await loadTopicState(agentId);
  if (!state?.open || state.open.messageIds.length === 0) return 0;

  // 消息正文以热存储为单事实源，按 id 回读；已归档/已删除的 id 自然过滤
  const messages = await repo.getByIds(state.open.messageIds);
  if (messages.length === 0) {
    await clearTopicState(agentId);
    return 0;
  }

  const segment: TopicSegment = {
    topicId: `tp_${Date.now()}_reconcile_${randomUUID().slice(0, 8)}`,
    messages,
    sourceId: state.open.sourceId,
    sourceName: state.open.sourceName,
    startedAt: messages[0]!.createdAt,
    endedAt: messages[messages.length - 1]!.createdAt,
    // 与 tracker 同一规则：短话题不浪费 LLM 调用，仅归档
    archiveOnly: messages.length < MIN_SEGMENT_MESSAGES,
  };
  await runCompressionTask(segment, deps);
  await clearTopicState(agentId);
  return messages.length;
}


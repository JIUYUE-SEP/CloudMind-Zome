import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IMessageRepository } from "./repositories/types.js";
import { archivedMessageIds, compressedDir } from "./topic/store.js";
import {
  clearTopicState,
  loadTopicState,
  removePendingSegment,
  saveTopicState,
} from "./topic/state.js";
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
    await consumeOpenState(agentId);
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
  await consumeOpenState(agentId);
  return messages.length;
}

/** open 已消费：清 open 字段；pending 也空时删整个状态文件 */
async function consumeOpenState(agentId: string): Promise<void> {
  await saveTopicState(agentId, null);
  const state = await loadTopicState(agentId);
  if (!state || ((state.pending ?? []).length === 0 && state.open === null)) {
    await clearTopicState(agentId);
  }
}

/**
 * 启动对账扩展（P1.5 M-b）：补"已关闭已入队未压缩"的话题段。
 *
 * closeSegment 清空 open、段入压缩队列后，进程在任务执行前退出（desktop
 * taskkill /F 主路径下 shutdown handler 根本不跑），该段两个对账方向都够不着：
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


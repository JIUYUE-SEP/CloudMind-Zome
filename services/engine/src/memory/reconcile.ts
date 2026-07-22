import type { IMessageRepository } from "./repositories/types.js";
import { archivedMessageIds } from "./topic/store.js";

/**
 * 启动对账（Phase 2 review M3 建议的"压缩档 msgIds ∩ 热存储"补归档）。
 *
 * 覆盖的孤儿类型：压缩档已写入、但 archiveAndRemove 未完成的消息——
 * 进程在"写压缩档 → 归档"两步之间退出，或压缩队列在退出时丢弃了未完成项。
 * 这类消息已有 L5 摘要，留在热存储会被 L4 重复检索注入，且永不再被归档。
 *
 * 不覆盖的孤儿类型：进程退出时尚在未关闭话题里的消息（没有压缩档指向它们，
 * 无法仅靠文件对账识别，需要重跑话题检测，不在本模块范围）。
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

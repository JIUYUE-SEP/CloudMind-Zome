import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DocumentStore, renameWithRetry } from "../../plugins/memory/document-store.js";
import { getAgentDir, sanitizeAgentId } from "../../config/paths.js";
import { UnsupportedSchemaVersionError } from "../../versioning.js";
import { logger } from "../../logger.js";

/**
 * 话题跟踪器状态落盘（P1-2，数据 review M6；P1.5 M-b 扩展 pending 段）。
 *
 * tracker 的话题累积状态原本只存内存：进程退出时仍在未关闭话题里的消息
 * 没有任何压缩档指向，重启后永远留在热存储（重启孤儿）。这里把"当前开放
 * 话题"落盘到 topic-state.json（AgentWorker 在 turn 起点/每个 step 落盘后/
 * turn 终点各写一次），重启后由启动对账（reconcile.ts）识别并补压缩/归档。
 *
 * M-b 扩展：压缩段"入队即记状态"——closeSegment 清空 open 后、压缩任务
 * 执行前进程退出（强杀无优雅关停）会让整段消息两个对账方向
 * 都够不着。段入队时先落一条 pending 记录（含 messageIds 与 archiveOnly），
 * 任务成功完成才清除；启动对账按 pending 补压缩/补归档。
 *
 * 方案取舍：turn 边界 + step 边界落盘（~1KB/次、每 turn ≤7 次），不选每次消息
 * 全量写；且只记消息 id 与边界元数据，不记正文——正文以热存储为准，对账时按
 * id 回读，避免双写不一致。I/O 成本相对每 turn 一次 LLM 调用可忽略。文件经
 * DocumentStore 读写，自动携带 P1-1 的 schemaVersion 版本字段；pending 为
 * 可选追加字段，旧版状态文件（无 pending）读取语义不变。
 */

/** 当前开放话题的快照：重启后对账重建 segment 所需的最小信息 */
export interface OpenTopicSnapshot {
  /** 话题内消息的 id（按到达顺序；正文对账时从热存储回读） */
  messageIds: string[];
  /** 话题首条消息时间（ISO） */
  startedAt: string;
  /** 关闭时所在场景（会话） */
  sourceId: string;
  sourceName?: string;
}

/** 已关闭已入队、等待/正在压缩的话题段（M-b）：崩溃后由启动对账补漏 */
export interface PendingSegmentSnapshot {
  topicId: string;
  messageIds: string[];
  startedAt: string;
  endedAt: string;
  sourceId: string;
  sourceName?: string;
  archiveOnly: boolean;
}

export interface TopicStateFile {
  /** 当前开放话题；null 表示无未关闭话题 */
  open: OpenTopicSnapshot | null;
  /** 已入队未完成的压缩段（M-b）；无此字段的旧文件视为空 */
  pending?: PendingSegmentSnapshot[];
}

function stateStore(agentId: string): DocumentStore<TopicStateFile> {
  return new DocumentStore<TopicStateFile>(
    path.join(getAgentDir(sanitizeAgentId(agentId)), "topic-state.json"),
  );
}

/**
 * 状态文件按 agent 串行"读-改-写"：open（turn/step 边界）与 pending
 * （入队/完成）由不同调用点更新同一文件，非原子的读改写会互相覆盖
 * （如 turn 终点写 open:null 丢掉刚入队的 pending）。与 DocumentStore
 * 写队列同理挂模块级 per-agent 链。
 */
const stateOpChains = new Map<string, Promise<void>>();

function enqueueStateOp<T>(agentId: string, op: () => Promise<T>): Promise<T> {
  const prev = stateOpChains.get(agentId) ?? Promise.resolve();
  const next = prev.then(op, op);
  // 链上存不 reject 的尾巴（op 失败不影响后续 op 入链），cleanup 以同一引用比较
  const stored = next.then(
    () => undefined,
    () => undefined,
  );
  stateOpChains.set(agentId, stored);
  void stored.then(() => {
    if (stateOpChains.get(agentId) === stored) stateOpChains.delete(agentId);
  });
  return next;
}

async function updateTopicState(
  agentId: string,
  updater: (current: TopicStateFile) => TopicStateFile,
): Promise<void> {
  await enqueueStateOp(agentId, async () => {
    const current = (await loadTopicState(agentId)) ?? { open: null };
    await stateStore(agentId).writeJson(updater(current));
  });
}

/** 读取 tracker 落盘状态；文件不存在返回 undefined（无状态可对账） */
export async function loadTopicState(agentId: string): Promise<TopicStateFile | undefined> {
  const store = stateStore(agentId);
  try {
    return await store.readJson();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // F2：高版本文件不是损坏——版本错误原样上抛（照 config/repository.ts 范式：
    // 版本检查不进损坏隔离分支），不隔离、不回空态，文件不做任何改动
    // （versioning.ts「高版本文件不做任何改动」契约）；仅真损坏才走下方隔离
    if (err instanceof UnsupportedSchemaVersionError) throw err;
    // 损坏隔离（D1 欠账修复，照 handoff/state.ts A3 同模式）：重命名 .corrupt-
    // {timestamp}-{随机后缀} 备份后以空态启动 + warn——绝不静默覆盖损坏数据
    // （后续 save 会重建干净文件），也不让坏文件炸掉 turn 主流程/启动对账。
    // 随机后缀防同一毫秒内多次 load 撞同名；rename 失败不静默吞——单独 warn
    // 带失败原因，外层 warn 如实区分「已隔离」与「隔离失败」。
    const quarantinePath = `${store.filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let quarantined = false;
    try {
      await renameWithRetry(store.filePath, quarantinePath);
      quarantined = true;
    } catch (renameErr) {
      logger.warn(
        { err: renameErr, quarantinePath },
        "[topic] topic-state.json 隔离失败（损坏文件仍在原路径，后续 save 可能覆盖它）",
      );
    }
    logger.warn(
      { err: err, quarantinePath, quarantined },
      quarantined
        ? "[topic] topic-state.json 损坏，已隔离并以空态启动（不覆盖损坏数据）"
        : "[topic] topic-state.json 损坏且隔离失败：以空态启动，原路径损坏文件未被覆盖",
    );
    return undefined;
  }
}

/** 更新开放话题快照（保留 pending；调用方 await——agent-worker persistTopicState） */
export async function saveTopicState(agentId: string, open: OpenTopicSnapshot | null): Promise<void> {
  await updateTopicState(agentId, (current) => ({ ...current, open }));
}

/** 压缩段入队即记（M-b）：先落 pending 再入队，崩溃窗口由启动对账补漏 */
export async function addPendingSegment(agentId: string, segment: PendingSegmentSnapshot): Promise<void> {
  await updateTopicState(agentId, (current) => {
    const pending = (current.pending ?? []).filter((p) => p.topicId !== segment.topicId);
    pending.push(segment);
    return { ...current, pending };
  });
}

/** 压缩任务成功完成后清除 pending（失败保留，下次启动对账重试） */
export async function removePendingSegment(agentId: string, topicId: string): Promise<void> {
  await updateTopicState(agentId, (current) => ({
    ...current,
    pending: (current.pending ?? []).filter((p) => p.topicId !== topicId),
  }));
}

/** 对账完成且状态已全部消费后清除状态文件（不存在的文件静默忽略） */
export async function clearTopicState(agentId: string): Promise<void> {
  await fs
    .unlink(path.join(getAgentDir(sanitizeAgentId(agentId)), "topic-state.json"))
    .catch(() => {});
}

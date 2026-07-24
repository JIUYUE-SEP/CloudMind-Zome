import path from "node:path";
import fs from "node:fs/promises";
import { DocumentStore } from "../document-store.js";
import { getAgentDir, sanitizeAgentId } from "../../config/paths.js";

/**
 * 话题跟踪器状态落盘（P1-2，数据 review M6）。
 *
 * tracker 的话题累积状态原本只存内存：进程退出时仍在未关闭话题里的消息
 * 没有任何压缩档指向，重启后永远留在热存储（重启孤儿）。这里把"当前开放
 * 话题"落盘到 topic-state.json（AgentWorker 在每个 turn 的起点与终点各写
 * 一次），重启后由启动对账（reconcile.ts）识别并补压缩/归档。
 *
 * 方案取舍：turn 边界落盘（约 2 次/turn、~1KB），不选每次消息全量写；且只记
 * 消息 id 与边界元数据，不记正文——正文以热存储为准，对账时按 id 回读，避免
 * 双写不一致。I/O 成本相对每 turn 一次 LLM 调用可忽略。崩溃恰好打在 turn 进行
 * 中时，状态停留在 turn 起点快照（含本轮用户消息），损失上限为一个 turn 的
 * assistant 输出条数，有界。文件经 DocumentStore 读写，自动携带 P1-1 的
 * schemaVersion 版本字段。
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

export interface TopicStateFile {
  /** 当前开放话题；null 表示无未关闭话题 */
  open: OpenTopicSnapshot | null;
}

function stateStore(agentId: string): DocumentStore<TopicStateFile> {
  return new DocumentStore<TopicStateFile>(
    path.join(getAgentDir(sanitizeAgentId(agentId)), "topic-state.json"),
  );
}

/** 读取 tracker 落盘状态；文件不存在返回 undefined（无状态可对账） */
export async function loadTopicState(agentId: string): Promise<TopicStateFile | undefined> {
  return stateStore(agentId).readJson();
}

/** 写入 tracker 状态（fire-and-forget 调用方自行 catch；writeJson 按文件串行） */
export async function saveTopicState(agentId: string, open: OpenTopicSnapshot | null): Promise<void> {
  await stateStore(agentId).writeJson({ open });
}

/** 对账完成后清除状态文件（不存在的文件静默忽略） */
export async function clearTopicState(agentId: string): Promise<void> {
  await fs
    .unlink(path.join(getAgentDir(sanitizeAgentId(agentId)), "topic-state.json"))
    .catch(() => {});
}

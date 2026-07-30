import fs from "node:fs/promises";
import path from "node:path";
import { DocumentStore, renameWithRetry } from "../memory/document-store.js";
import { getAgentDir, getDataDir, sanitizeAgentId } from "../config/paths.js";
import type { SubagentTaskKind, SubagentTaskStatus } from "./types.js";

/**
 * 任务表内只存 preview：最终输出超过 ~4KB 时截尾保留末尾 4096 字符
 * （kimi 输出双轨语义——结尾通常是结论），全量落 output.log。
 */
export const OUTPUT_PREVIEW_MAX_CHARS = 4096;

/** subagent 后台任务的持久化记录（subagent-tasks.jsonl 一行） */
export interface SubagentTaskRecord {
  taskId: string;
  parentAgentId: string;
  /** 被借用 agent */
  agentId: string;
  kind: SubagentTaskKind;
  taskDescription: string;
  status: SubagentTaskStatus;
  /** 输出 preview（截尾 + outputTruncated 标记）；全量在 subagent-tasks/<taskId>.output.log */
  outputPreview: string;
  outputTruncated: boolean;
  error?: string;
  startTime: number;
  endTime?: number;
  timeoutMs: number;
}

/** taskId 只作路径段用，字符白名单防路径穿越（生产为 UUID，测试可见短横线 id） */
const VALID_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function makeOutputPreview(output: string): { preview: string; truncated: boolean } {
  if (output.length <= OUTPUT_PREVIEW_MAX_CHARS) return { preview: output, truncated: false };
  return { preview: output.slice(-OUTPUT_PREVIEW_MAX_CHARS), truncated: true };
}

/**
 * subagent 后台任务持久化（仿 plan/repository.ts 的 DocumentStore 模式）。
 *
 * 布局：任务表全局一份 DATA_DIR/subagent-tasks.jsonl——现有任务表本就是全局
 * 单例（Map 按 taskId 索引，REST 查询不带 agent 维度），全局表免去跨 agent 目
 * 录扫描；输出全量日志按任务归属落到 parent agent 目录
 * （agents/<parentAgentId>/subagent-tasks/<taskId>.output.log，kimi per-agent
 * tasks/ 布局的简化版）。
 */
export class SubagentTaskRepository {
  private store: DocumentStore<SubagentTaskRecord>;

  constructor(filePath: string = path.join(getDataDir(), "subagent-tasks.jsonl")) {
    this.store = new DocumentStore<SubagentTaskRecord>(filePath);
  }

  async loadAll(): Promise<SubagentTaskRecord[]> {
    return this.store.readLines();
  }

  /** 按 taskId 更新已有记录；不存在则追加 */
  async upsert(record: SubagentTaskRecord): Promise<void> {
    await this.store.mutateLines((records) => {
      const index = records.findIndex((r) => r.taskId === record.taskId);
      if (index === -1) return [...records, record];
      records[index] = record;
      return records;
    });
  }

  /**
   * 启动对账（lost 语义）：持久化表里仍处于 running 的任务一律标 lost——
   * 重启后执行现场已毁，不知死活≠已知失败，交人工决策而非自动续跑。
   * 返回标记数量。
   */
  async markRunningAsLost(): Promise<number> {
    let count = 0;
    await this.store.mutateLines((records) => {
      for (const record of records) {
        if (record.status === "running") {
          record.status = "lost";
          record.endTime = Date.now();
          count++;
        }
      }
      return records;
    });
    return count;
  }

  private outputLogPath(parentAgentId: string, taskId: string): string {
    sanitizeAgentId(parentAgentId);
    if (!VALID_TASK_ID.test(taskId)) throw new Error(`Invalid task id: "${taskId}"`);
    return path.join(getAgentDir(parentAgentId), "subagent-tasks", `${taskId}.output.log`);
  }

  /** 全量输出落盘（tmp+rename 原子写，与 DocumentStore 同范式）；只在完成/失败时调用 */
  async writeTaskOutput(parentAgentId: string, taskId: string, output: string): Promise<void> {
    const filePath = this.outputLogPath(parentAgentId, taskId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, output, "utf-8");
    await renameWithRetry(tmpPath, filePath);
  }

  /** 全量输出读取的尺寸上限（防超大 log 整读撑爆内存，review 建议） */
  static readonly MAX_OUTPUT_READ_BYTES = 10 * 1024 * 1024;

  /**
   * 读全量输出；无日志（任务失败/lost 无输出）或 id 不合法返回 undefined。
   * 超过 MAX_OUTPUT_READ_BYTES 时抛错（路由层映射 413），不整读入内存。
   */
  async readTaskOutput(parentAgentId: string, taskId: string): Promise<string | undefined> {
    if (!VALID_TASK_ID.test(taskId)) return undefined;
    const filePath = this.outputLogPath(parentAgentId, taskId);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > SubagentTaskRepository.MAX_OUTPUT_READ_BYTES) {
        throw new Error(
          `output.log 超过读取上限（${stat.size} > ${SubagentTaskRepository.MAX_OUTPUT_READ_BYTES} bytes），请直接在数据目录查阅文件`,
        );
      }
      return await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
}

import { logger } from "../logger.js";
import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import type { SubagentTask } from "./types.js";
import type { SubagentTaskKind, SubagentTaskStatus } from "./types.js";
import {
  makeOutputPreview,
  SubagentTaskRepository,
  type SubagentTaskRecord,
} from "./task-repository.js";

export interface BackgroundSubagent {
  taskId: string;
  parentAgentId: string;
  /** 被借用 agent */
  agentId: string;
  kind: SubagentTaskKind;
  taskDescription: string;
  status: SubagentTaskStatus;
  /** 输出 preview（超 ~4KB 截尾 + outputTruncated 标记）；全量经 readFullOutput 读取 */
  output: string;
  outputTruncated: boolean;
  error?: string;
  startTime: number;
  endTime?: number;
  timeoutMs: number;
  /** 运行期专用（任务消息与借用 agent 配置）；重启恢复的历史记录没有 */
  task?: SubagentTask;
  config?: AgentConfig;
}

function toRecord(bg: BackgroundSubagent): SubagentTaskRecord {
  return {
    taskId: bg.taskId,
    parentAgentId: bg.parentAgentId,
    agentId: bg.agentId,
    kind: bg.kind,
    taskDescription: bg.taskDescription,
    status: bg.status,
    outputPreview: bg.output,
    outputTruncated: bg.outputTruncated,
    error: bg.error,
    startTime: bg.startTime,
    endTime: bg.endTime,
    timeoutMs: bg.timeoutMs,
  };
}

function fromRecord(record: SubagentTaskRecord): BackgroundSubagent {
  return {
    taskId: record.taskId,
    parentAgentId: record.parentAgentId,
    agentId: record.agentId,
    kind: record.kind,
    taskDescription: record.taskDescription,
    status: record.status,
    output: record.outputPreview,
    outputTruncated: record.outputTruncated,
    error: record.error,
    startTime: record.startTime,
    endTime: record.endTime,
    timeoutMs: record.timeoutMs,
  };
}

/**
 * 后台 subagent 任务管理：内存索引 + 状态变更点落盘（SubagentTaskRepository，
 * 参照 PlanManager 模式）。重启后 load() 回填索引，running 一律标 lost。
 */
export class BackgroundManager {
  private tasks = new Map<string, BackgroundSubagent>();
  private listeners: Array<(task: BackgroundSubagent) => void> = [];

  constructor(
    private deps: {
      runAgent(agentId: string, messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<string>;
      /** puppet 后台执行口（2b）：傀儡任务不走 AgentWorker，经 PuppetRunner 裸跑 */
      runPuppet?(ownerAgentId: string, taskDescription: string, opts?: { signal?: AbortSignal }): Promise<string>;
    },
    private repository: SubagentTaskRepository,
  ) {}

  /** 启动加载：持久化记录回填内存索引；running 标 lost（重启语义：不知死活≠已知失败） */
  async load(): Promise<void> {
    const lost = await this.repository.markRunningAsLost();
    if (lost > 0) {
      logger.warn(`[subagent] 启动对账：${lost} 个 running 后台任务标记为 lost（重启前未完成，死活未知）`);
    }
    const records = await this.repository.loadAll();
    for (const record of records) {
      this.tasks.set(record.taskId, fromRecord(record));
    }
  }

  register(task: SubagentTask, config: AgentConfig, timeoutMs: number, kind: SubagentTaskKind = "delegate"): void {
    const bg: BackgroundSubagent = {
      taskId: task.id,
      parentAgentId: task.parentAgentId,
      agentId: config.id,
      kind,
      taskDescription: task.taskDescription,
      status: "running",
      output: "",
      outputTruncated: false,
      startTime: Date.now(),
      timeoutMs,
      task,
      config,
    };
    this.tasks.set(task.id, bg);
    void this.persist(bg);
    void this.run(bg);
  }

  private async run(bg: BackgroundSubagent): Promise<void> {
    if (!bg.task || !bg.config) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // puppet 走傀儡裸跑（owner=parentAgentId，无审批通道——写类工具 fail-closed）；
      // delegate 走 AgentWorker 队列（现状路径）
      const execution =
        bg.kind === "puppet" && this.deps.runPuppet
          ? this.deps.runPuppet(bg.parentAgentId, bg.taskDescription, { signal: controller.signal })
          : this.deps.runAgent(bg.config.id, bg.task.messages, { signal: controller.signal });
      const full = await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), bg.timeoutMs);
        }),
      ]);
      // 输出双轨：全量落 output.log，内存/任务表只存截尾 preview
      const { preview, truncated } = makeOutputPreview(full);
      bg.output = preview;
      bg.outputTruncated = truncated;
      bg.status = "completed";
      bg.endTime = Date.now();
      await this.persist(bg, full);
    } catch (err) {
      // 超时（或失败）后中止 worker 里仍在跑的任务，避免空转继续烧 token
      controller.abort();
      bg.error = String(err);
      bg.status = "failed";
      bg.endTime = Date.now();
      await this.persist(bg);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.notify(bg);
  }

  /** 状态变更点落盘（同 Plan：注册/完成/失败）；落盘失败只记 warn，不影响任务语义 */
  private async persist(bg: BackgroundSubagent, fullOutput?: string): Promise<void> {
    try {
      if (fullOutput !== undefined && fullOutput.length > 0) {
        await this.repository.writeTaskOutput(bg.parentAgentId, bg.taskId, fullOutput);
      }
      await this.repository.upsert(toRecord(bg));
    } catch (err) {
      logger.warn({ err }, `[subagent] 任务 ${bg.taskId} 状态落盘失败`);
    }
  }

  /** 读任务全量输出（output.log）；任务未知或无输出日志返回 undefined */
  async readFullOutput(taskId: string): Promise<string | undefined> {
    const bg = this.tasks.get(taskId);
    if (!bg) return undefined;
    return this.repository.readTaskOutput(bg.parentAgentId, taskId);
  }

  private notify(bg: BackgroundSubagent): void {
    for (const listener of this.listeners) {
      listener(bg);
    }
  }

  onUpdate(listener: (task: BackgroundSubagent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  get(taskId: string): BackgroundSubagent | undefined {
    return this.tasks.get(taskId);
  }

  list(): BackgroundSubagent[] {
    return Array.from(this.tasks.values());
  }
}

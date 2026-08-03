import { randomUUID } from "node:crypto";
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
  /** 执行尝试次数（swarm 限流续跑复用同一记录）；注册为 1 */
  attempts: number;
  /** 终态通知幂等标记：任务记录生命周期内 notify 只发一次 */
  notified: boolean;
  /** puppet 任务的型号名（派发时指定；随记录持久化，resume 按名重新解析） */
  puppetModel?: string;
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
    attempts: bg.attempts,
    notified: bg.notified,
    ...(bg.puppetModel !== undefined ? { puppetModel: bg.puppetModel } : {}),
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
    attempts: record.attempts ?? 1,
    notified: record.notified ?? false,
    ...(record.puppetModel !== undefined ? { puppetModel: record.puppetModel } : {}),
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
      runPuppet?(
        ownerAgentId: string,
        taskDescription: string,
        opts?: { signal?: AbortSignal; puppetModel?: string },
      ): Promise<string>;
      /**
       * 终态通知钩子（阶段 4）：任务进入 completed/failed 时调用（bootstrap 接线到
       * owner worker 的注入通道）。幂等由管理器保证（notified 标记只发一次）；
       * 回调抛错只记 warn，不影响任务收尾
       */
      onTaskTerminal?(bg: BackgroundSubagent): void;
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

  register(
    task: SubagentTask,
    config: AgentConfig,
    timeoutMs: number,
    kind: SubagentTaskKind = "delegate",
    puppetModel?: string,
  ): void {
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
      attempts: 1,
      notified: false,
      ...(puppetModel !== undefined ? { puppetModel } : {}),
      task,
      config,
    };
    this.tasks.set(task.id, bg);
    void this.persist(bg);
    void this.run(bg);
  }

  /**
   * swarm 受管尝试（阶段 3）：注册任务记录并执行一次，完成/失败由管理器落盘，
   * 完成句柄随返回值给出。与 register 的区别：执行器由调用方注入（调度核驱动），
   * 不做内部超时计时（超时/取消经执行器自身的 signal 贯入）。
   */
  startTracked(
    task: SubagentTask,
    config: AgentConfig,
    timeoutMs: number,
    kind: SubagentTaskKind,
    execute: () => Promise<string>,
  ): { taskId: string; completion: Promise<string> } {
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
      attempts: 1,
      notified: false,
      task,
      config,
    };
    this.tasks.set(task.id, bg);
    void this.persist(bg);
    return { taskId: task.id, completion: this.runTracked(bg, execute) };
  }

  /**
   * swarm 限流续跑：复用同一任务记录（taskId 不变、状态回 running、attempts+1），
   * 不新建记录——傀儡无状态，续跑=同简报重新执行。
   */
  retryTracked(
    taskId: string,
    execute: () => Promise<string>,
  ): { taskId: string; completion: Promise<string> } {
    const bg = this.tasks.get(taskId);
    if (!bg) throw new Error(`Tracked task ${taskId} not found`);
    bg.status = "running";
    bg.attempts += 1;
    bg.error = undefined;
    bg.endTime = undefined;
    void this.persist(bg);
    return { taskId, completion: this.runTracked(bg, execute) };
  }

  /**
   * 任务 resume（阶段 4）：终态任务按原 kind 走原路径重新执行——
   * 统一语义 = 同简报重跑（delegate 不是常驻会话、傀儡本无状态，
   * 都没有 kimi 那样的持久 wire 上下文可续，诚实差异注于此）。
   * 复用原任务记录：taskId 不变、status 回 running、attempts+1、清 error/endTime。
   * running 任务拒绝（REST 层映射 409）；不存在抛错（REST 层映射 404）。
   */
  resume(taskId: string): { taskId: string; completion: Promise<string> } {
    const bg = this.tasks.get(taskId);
    if (!bg) throw new Error(`Task ${taskId} not found`);
    if (bg.status === "running") throw new Error(`Task ${taskId} is still running`);

    const execute = (): Promise<string> => {
      if (bg.kind === "puppet" && this.deps.runPuppet) {
        return this.deps.runPuppet(bg.parentAgentId, bg.taskDescription, {
          puppetModel: bg.puppetModel,
        });
      }
      // delegate：原简报重建 user 消息（与 dispatcher 首次派发同构），走 AgentWorker 路径
      const messages: ChatMessage[] = [
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: bg.taskDescription }],
          createdAt: new Date().toISOString(),
        },
      ];
      return this.deps.runAgent(bg.agentId, messages);
    };
    return this.retryTracked(taskId, execute);
  }

  /** 受管尝试统一收尾：成功写双轨输出，失败记 error；异常随 completion 上抛给调度核 */
  private async runTracked(bg: BackgroundSubagent, execute: () => Promise<string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 硬超时兜底（review 建议）：signal 是协作式取消，runTurn 仅在 step 边界检查——
      // provider 流中途挂起时 execute 永不 settle，批次悬挂且孤儿调用空转烧钱；
      // 与旧路径 run() 的 Promise.race 同范式，超时时限用任务记录的 timeoutMs
      const full = await Promise.race([
        execute(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timeout（受管执行硬超时 ${bg.timeoutMs}ms）`)),
            bg.timeoutMs,
          );
        }),
      ]);
      const { preview, truncated } = makeOutputPreview(full);
      bg.output = preview;
      bg.outputTruncated = truncated;
      bg.status = "completed";
      bg.endTime = Date.now();
      await this.persist(bg, full);
      return full;
    } catch (err) {
      bg.error = String(err);
      bg.status = "failed";
      bg.endTime = Date.now();
      await this.persist(bg);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      await this.notifyTerminalOnce(bg);
      this.notify(bg);
    }
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
          ? this.deps.runPuppet(bg.parentAgentId, bg.taskDescription, {
              signal: controller.signal,
              puppetModel: bg.puppetModel,
            })
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
    await this.notifyTerminalOnce(bg);
    this.notify(bg);
  }

  /**
   * 终态通知（幂等）：completed/failed 时触发 onTaskTerminal 钩子；
   * notified 标记随记录落盘——任务生命周期内只发一次（resume 后再终态不重复）；
   * 钩子异常只记 warn，不影响任务收尾。落盘 await（不 fire-and-forget），
   * 避免收尾后仍在飞的写与进程退出/测试清理撞车
   */
  private async notifyTerminalOnce(bg: BackgroundSubagent): Promise<void> {
    if (bg.notified) return;
    if (bg.status !== "completed" && bg.status !== "failed") return;
    bg.notified = true;
    await this.persist(bg);
    if (!this.deps.onTaskTerminal) return;
    try {
      this.deps.onTaskTerminal(bg);
    } catch (err) {
      logger.warn({ err }, `[subagent] 任务 ${bg.taskId} 终态通知回调异常`);
    }
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

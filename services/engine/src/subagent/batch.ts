import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { AgentConfig } from "@cloudmind/shared";
import type { BackgroundManager } from "./background.js";
import type { SubagentResult, SubagentTask } from "./types.js";
import {
  AgentRunBatch,
  resolveSwarmMaxConcurrency,
  type AgentRunBatchLauncher,
  type SwarmAttemptHandle,
} from "./agent-run-batch.js";

/**
 * Swarm 批量派发（阶段 3）：kimi AgentRunBatch 调度核 + 全傀儡 Launcher。
 * 成员全部是傀儡（kind=puppet，批量任务不污染任何人形的记忆）；
 * swarm 任务无审批桥接（approve=undefined，写类 fail-closed）——
 * swarm 面向只读/分析/汇总类批量任务，防止批量审批弹窗轰炸。
 */

export interface SwarmItemInput {
  /** 展开后的完整简报（prompt_template 填充 {{item}} 后的结果） */
  prompt: string;
  /** 原始 item 文本（结果聚合展示用） */
  item: string;
}

export interface SwarmItemResult {
  index: number;
  item: string;
  status: "completed" | "failed" | "aborted";
  output?: string;
  error?: string;
  taskId?: string;
}

export class SubagentSwarm {
  constructor(
    private deps: {
      getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
      runPuppet(ownerAgentId: string, prompt: string, opts?: { signal?: AbortSignal }): Promise<string>;
      background: BackgroundManager;
    },
  ) {}

  /** 批量执行（一次性返回，原位聚合）；单任务超时默认 120s，取消经 signal 贯入每个傀儡 */
  async run(
    ownerAgentId: string,
    items: SwarmItemInput[],
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SwarmItemResult[]> {
    const ownerConfig = await this.deps.getAgentConfig(ownerAgentId);
    if (!ownerConfig) {
      throw new Error(`Agent ${ownerAgentId} not found`);
    }
    const manager = this.deps.background;
    const runPuppet = this.deps.runPuppet;
    // M24：本批任务的终态通知聚合身份——同批终态合并为一条汇总通知（替代逐任务通知风暴）
    const notifyBatch = { id: `swarm_${randomUUID()}`, total: items.length };

    // Launcher 接傀儡执行：spawn 注册新任务记录（kind=puppet），
    // retry 复用同一记录（taskId 不变、attempts+1）；首版 resume 与 retry 同实现。
    // 傀儡 signal = 调度核 attempt 信号 ∪ runTracked 硬超时信号（M23：任一中止都停傀儡）
    const launcher: AgentRunBatchLauncher = {
      spawn: async (o): Promise<SwarmAttemptHandle> => {
        const task: SubagentTask = {
          id: randomUUID(),
          parentAgentId: ownerAgentId,
          taskDescription: o.prompt,
          messages: [],
        };
        const handle = manager.startTracked(
          task,
          ownerConfig,
          opts.timeoutMs ?? 120_000,
          "puppet",
          (signal) => runPuppet(ownerAgentId, o.prompt, { signal: AbortSignal.any([o.signal, signal]) }),
          notifyBatch,
        );
        o.onReady?.();
        return { agentId: handle.taskId, completion: handle.completion };
      },
      retry: async (taskId, o): Promise<SwarmAttemptHandle> => {
        const handle = manager.retryTracked(taskId, (signal) =>
          runPuppet(ownerAgentId, o.prompt, { signal: AbortSignal.any([o.signal, signal]) }),
        );
        o.onReady?.();
        return { agentId: handle.taskId, completion: handle.completion };
      },
      resume: async (taskId, o): Promise<SwarmAttemptHandle> => {
        const handle = manager.retryTracked(taskId, (signal) =>
          runPuppet(ownerAgentId, o.prompt, { signal: AbortSignal.any([o.signal, signal]) }),
        );
        o.onReady?.();
        return { agentId: handle.taskId, completion: handle.completion };
      },
      suspended: (event) => {
        logger.warn(`[swarm] 限流，任务 ${event.agentId} 回队头待重试（复用同一记录）`);
      },
    };

    const tasks = items.map((it, index) => ({
      prompt: it.prompt,
      description: it.prompt,
      swarmIndex: index,
      swarmItem: it.item,
      timeout: opts.timeoutMs ?? 120_000,
      signal: opts.signal,
    }));
    const batch = new AgentRunBatch(launcher, tasks, {
      maxConcurrency: resolveSwarmMaxConcurrency(),
    });
    const results = await batch.run();
    return results.map((r, index) => ({
      index,
      item: items[index]!.item,
      status: r.status,
      output: r.result,
      error: r.error,
      taskId: r.agentId,
    }));
  }
}

export interface SubagentBatchOptions {
  concurrency?: number;
  timeoutMs?: number;
}

/**
 * 旧骨架的对外形状保留（dispatch 函数式批量），内部已换 AgentRunBatch 调度核：
 * 并发由 burst-then-throttle 坡道控制，失败原位聚合，限流走内核自适应续跑。
 */
export class SubagentBatch {
  constructor(private dispatch: (input: string) => Promise<SubagentResult>) {}

  async run(inputs: string[], options: SubagentBatchOptions = {}): Promise<SubagentResult[]> {
    const dispatch = this.dispatch;
    const launcher: AgentRunBatchLauncher = {
      spawn: (o) =>
        Promise.resolve({
          agentId: `batch_${o.swarmIndex ?? 0}`,
          completion: dispatch(o.prompt).then((r) => {
            if (r.error) throw new Error(r.error);
            return r.output;
          }),
        }),
      retry: (agentId, o) => launcher.spawn({ ...o, swarmItem: undefined }),
      resume: (agentId, o) => launcher.spawn({ ...o, swarmItem: undefined }),
    };
    const tasks = inputs.map((input, index) => ({
      prompt: input,
      description: input,
      swarmIndex: index,
      timeout: options.timeoutMs,
    }));
    const batch = new AgentRunBatch(launcher, tasks, { maxConcurrency: options.concurrency });
    const results = await batch.run();
    return results.map((r, index) =>
      r.status === "completed"
        ? { taskId: `batch_${index}`, output: r.result ?? "" }
        : { taskId: `batch_${index}`, output: "", error: r.error ?? "failed" },
    );
  }
}

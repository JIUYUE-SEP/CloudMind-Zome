import { randomUUID } from "node:crypto";
import { MAX_FOREGROUND_TIMEOUT_MS, type AgentConfig, type ChatMessage } from "@mindcloud/shared";
import type { BackgroundManager } from "./background.js";
import type { PuppetRunner } from "./puppet.js";
import type { SubagentOptions, SubagentResult, SubagentTask } from "./types.js";

// MAX_FOREGROUND_TIMEOUT_MS 已迁至 @mindcloud/shared（P3 切 tools→subagent 值边）

export interface SubagentDispatcherDependencies {
  getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
  runAgent(agentId: string, messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<string>;
  background?: BackgroundManager;
  /** puppet 执行路径（2b）：kind=puppet 时走 PuppetRunner，忽略借用目标 */
  puppet?: PuppetRunner;
}

export class SubagentDispatcher {
  constructor(private deps: SubagentDispatcherDependencies) {}

  async dispatch(
    parentAgentId: string,
    borrowedAgentId: string,
    taskDescription: string,
    options: SubagentOptions
  ): Promise<SubagentResult | string> {
    if (options.kind === "puppet") {
      // puppet 忽略 targetAgentId：傀儡是 caller 的一次性分身，主人=调用方
      return this.dispatchPuppet(parentAgentId, taskDescription, options);
    }
    if (borrowedAgentId === parentAgentId) {
      throw new Error(`Agent ${borrowedAgentId} cannot dispatch to itself`);
    }
    const config = await this.deps.getAgentConfig(borrowedAgentId);
    if (!config) {
      throw new Error(`Agent ${borrowedAgentId} not found`);
    }

    const task: SubagentTask = {
      id: randomUUID(),
      parentAgentId,
      taskDescription,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: taskDescription }],
          createdAt: new Date().toISOString(),
        },
      ],
    };

    if (options.mode === "background") {
      if (!this.deps.background) {
        throw new Error("BackgroundManager not available");
      }
      this.deps.background.register(task, config, options.timeoutMs ?? 120_000, "delegate");
      return task.id;
    }

    const timeoutMs = Math.min(options.timeoutMs ?? 120_000, MAX_FOREGROUND_TIMEOUT_MS);
    return this.runForeground(task, config, timeoutMs);
  }

  private async dispatchPuppet(
    ownerAgentId: string,
    taskDescription: string,
    options: SubagentOptions,
  ): Promise<SubagentResult | string> {
    if (!this.deps.puppet) {
      throw new Error("PuppetRunner not available");
    }
    const ownerConfig = await this.deps.getAgentConfig(ownerAgentId);
    if (!ownerConfig) {
      throw new Error(`Agent ${ownerAgentId} not found`);
    }

    const task: SubagentTask = {
      id: randomUUID(),
      parentAgentId: ownerAgentId,
      taskDescription,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: taskDescription }],
          createdAt: new Date().toISOString(),
        },
      ],
    };

    if (options.mode === "background") {
      if (!this.deps.background) {
        throw new Error("BackgroundManager not available");
      }
      // 任务表 record 的 agentId 记 owner（傀儡无独立人形）
      this.deps.background.register(
        task,
        ownerConfig,
        options.timeoutMs ?? 120_000,
        "puppet",
        options.puppetModel,
      );
      return task.id;
    }

    const timeoutMs = Math.min(options.timeoutMs ?? 120_000, MAX_FOREGROUND_TIMEOUT_MS);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        this.deps.puppet.run(ownerAgentId, taskDescription, {
          signal: controller.signal,
          approve: options.approve,
          puppetModel: options.puppetModel,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
      return { taskId: task.id, output };
    } catch (err) {
      // 超时（或失败）后中止仍在跑的傀儡，避免空转继续烧 token
      controller.abort();
      const error = err instanceof Error && err.message === "timeout" ? "timeout" : String(err);
      return { taskId: task.id, output: "", error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runForeground(task: SubagentTask, config: AgentConfig, timeoutMs: number): Promise<SubagentResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        this.deps.runAgent(config.id, task.messages, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
      return { taskId: task.id, output };
    } catch (err) {
      // 超时（或失败）后中止 worker 里仍在跑的任务，避免空转继续烧 token
      controller.abort();
      const error = err instanceof Error && err.message === "timeout" ? "timeout" : String(err);
      return { taskId: task.id, output: "", error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

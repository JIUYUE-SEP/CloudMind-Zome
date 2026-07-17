import { randomUUID } from "node:crypto";
import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import type { BackgroundManager } from "./background.js";
import type { SubagentOptions, SubagentResult, SubagentTask } from "./types.js";

export const MAX_FOREGROUND_TIMEOUT_MS = 300_000;

export interface SubagentDispatcherDependencies {
  getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
  runAgent(agentId: string, messages: ChatMessage[]): Promise<string>;
  background?: BackgroundManager;
}

export class SubagentDispatcher {
  constructor(private deps: SubagentDispatcherDependencies) {}

  async dispatch(
    parentAgentId: string,
    borrowedAgentId: string,
    taskDescription: string,
    options: SubagentOptions
  ): Promise<SubagentResult | string> {
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
      this.deps.background.register(task, config, options.timeoutMs ?? 120_000);
      return task.id;
    }

    const timeoutMs = Math.min(options.timeoutMs ?? 120_000, MAX_FOREGROUND_TIMEOUT_MS);
    return this.runForeground(task, config, timeoutMs);
  }

  private async runForeground(task: SubagentTask, config: AgentConfig, timeoutMs: number): Promise<SubagentResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        this.deps.runAgent(config.id, task.messages),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
      return { taskId: task.id, output };
    } catch (err) {
      const error = err instanceof Error && err.message === "timeout" ? "timeout" : String(err);
      return { taskId: task.id, output: "", error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

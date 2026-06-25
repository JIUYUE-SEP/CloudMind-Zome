import { randomUUID } from "node:crypto";
import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import type { BackgroundManager } from "./background.js";
import type { SubagentOptions, SubagentResult, SubagentTask } from "./types.js";

export interface SubagentDispatcherDependencies {
  getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
  runAgent(agentId: string, messages: ChatMessage[]): AsyncIterable<unknown>;
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

    return this.runForeground(task, config, options.timeoutMs ?? 120_000);
  }

  private async runForeground(task: SubagentTask, config: AgentConfig, timeoutMs: number): Promise<SubagentResult> {
    const messages: ChatMessage[] = [];
    const startTime = Date.now();
    for await (const event of this.deps.runAgent(config.id, task.messages)) {
      messages.push(event as ChatMessage);
      if (Date.now() - startTime > timeoutMs) {
        return { taskId: task.id, messages, error: "timeout" };
      }
    }
    return { taskId: task.id, messages };
  }
}

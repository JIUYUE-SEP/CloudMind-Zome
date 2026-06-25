import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import type { SubagentTask } from "./types.js";

export interface BackgroundSubagent {
  task: SubagentTask;
  config: AgentConfig;
  startTime: number;
  timeoutMs: number;
  status: "running" | "completed" | "failed";
  messages: ChatMessage[];
  error?: string;
}

export class BackgroundManager {
  private tasks = new Map<string, BackgroundSubagent>();
  private listeners: Array<(task: BackgroundSubagent) => void> = [];

  constructor(private deps: { runAgent(agentId: string, messages: ChatMessage[]): AsyncIterable<unknown> }) {}

  register(task: SubagentTask, config: AgentConfig, timeoutMs: number): void {
    const bg: BackgroundSubagent = {
      task,
      config,
      startTime: Date.now(),
      timeoutMs,
      status: "running",
      messages: [],
    };
    this.tasks.set(task.id, bg);
    this.run(bg);
  }

  private async run(bg: BackgroundSubagent): Promise<void> {
    try {
      const startTime = Date.now();
      for await (const event of this.deps.runAgent(bg.config.id, bg.task.messages)) {
        bg.messages.push(event as ChatMessage);
        if (Date.now() - startTime > bg.timeoutMs) {
          bg.error = "timeout";
          bg.status = "failed";
          this.notify(bg);
          return;
        }
      }
      bg.status = "completed";
    } catch (err) {
      bg.error = String(err);
      bg.status = "failed";
    }
    this.notify(bg);
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

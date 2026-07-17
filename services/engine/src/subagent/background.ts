import type { AgentConfig, ChatMessage } from "@mindcloud/shared";
import type { SubagentTask } from "./types.js";

export interface BackgroundSubagent {
  task: SubagentTask;
  config: AgentConfig;
  startTime: number;
  timeoutMs: number;
  status: "running" | "completed" | "failed";
  output: string;
  error?: string;
}

export class BackgroundManager {
  private tasks = new Map<string, BackgroundSubagent>();
  private listeners: Array<(task: BackgroundSubagent) => void> = [];

  constructor(private deps: { runAgent(agentId: string, messages: ChatMessage[]): Promise<string> }) {}

  register(task: SubagentTask, config: AgentConfig, timeoutMs: number): void {
    const bg: BackgroundSubagent = {
      task,
      config,
      startTime: Date.now(),
      timeoutMs,
      status: "running",
      output: "",
    };
    this.tasks.set(task.id, bg);
    void this.run(bg);
  }

  private async run(bg: BackgroundSubagent): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      bg.output = await Promise.race([
        this.deps.runAgent(bg.config.id, bg.task.messages),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), bg.timeoutMs);
        }),
      ]);
      bg.status = "completed";
    } catch (err) {
      bg.error = String(err);
      bg.status = "failed";
    } finally {
      if (timer) clearTimeout(timer);
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

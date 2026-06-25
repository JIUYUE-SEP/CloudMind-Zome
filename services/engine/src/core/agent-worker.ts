import type { ChatMessage } from "@mindcloud/shared";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LLMProvider, LLMEvent } from "../provider/types.js";
import { runTurn, type TurnInput } from "./react/turn.js";
import type { Tool } from "../tools/types.js";

export type AgentWorkerStatus = "idle" | "busy" | "paused";

export interface AgentWorkerConfig {
  agentId: string;
  model: string;
  provider: LLMProvider;
  tools: Tool[];
  workspaceDir: string;
  requiresApproval: (toolName: string, args: unknown) => boolean | Promise<boolean>;
}

export interface Job {
  id: string;
  messages: ChatMessage[];
  onEvent: (event: LLMEvent) => void;
}

export class AgentWorker {
  status: AgentWorkerStatus = "idle";
  private queue: Job[] = [];
  private runningJob: Job | null = null;

  constructor(private config: AgentWorkerConfig) {}

  enqueue(job: Job): void {
    this.queue.push(job);
    if (this.status === "idle") {
      this.processQueue();
    }
  }

  pause(): void {
    this.status = "paused";
  }

  resume(): void {
    this.status = "idle";
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.status !== "idle" || this.queue.length === 0) return;
    this.status = "busy";
    const job = this.queue.shift()!;
    this.runningJob = job;

    try {
      const toolsMap = new Map(this.config.tools.map((t) => [t.name, t]));
      const toolDescriptions = this.config.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(t.parameters),
        },
      }));

      const turnInput: TurnInput = {
        provider: this.config.provider,
        model: this.config.model,
        messages: job.messages,
        tools: toolDescriptions,
        toolCtx: {
          agentId: this.config.agentId,
          workspaceDir: this.config.workspaceDir,
          tools: toolsMap,
          requiresApproval: this.config.requiresApproval,
          emit: job.onEvent,
        },
        maxSteps: 5,
      };

      await runTurn(turnInput, job.onEvent);
    } catch (err) {
      job.onEvent({ type: "text.delta", delta: `\nError: ${String(err)}` });
    } finally {
      this.runningJob = null;
      if ((this.status as AgentWorkerStatus) !== "paused") {
        this.status = "idle";
        this.processQueue();
      }
    }
  }
}

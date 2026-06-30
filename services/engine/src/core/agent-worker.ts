import type { ChatMessage } from "@mindcloud/shared";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LLMProvider, LLMEvent } from "../provider/types.js";
import { runTurn, type TurnInput } from "./react/turn.js";
import type { Tool } from "../tools/types.js";
import type { IMessageRepository } from "../memory/repositories/types.js";
import type { ScheduledTaskJob } from "../scheduler/types.js";

export type AgentWorkerStatus = "idle" | "busy" | "paused";

export interface AgentWorkerConfig {
  agentId: string;
  model: string;
  provider: LLMProvider;
  tools: Tool[];
  workspaceDir: string;
  messageRepository: IMessageRepository;
  requiresApproval: (toolName: string, args: unknown) => boolean | Promise<boolean>;
  temperature?: number;
  topP?: number;
  embedder?: import("../provider/types.js").EmbedderProvider;
  imageProvider?: import("../provider/types.js").ImageGenProvider;
}

export interface Job {
  id: string;
  messages: ChatMessage[];
  sessionId?: string;
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

  async runScheduledTask(job: ScheduledTaskJob): Promise<void> {
    if (job.sessionId) {
      for (const msg of job.messages) {
        if (msg.role === "user") {
          await this.config.messageRepository
            .append({
              id: randomUUID(),
              sessionId: job.sessionId,
              role: "user",
              content: msg.content,
              createdAt: new Date().toISOString(),
            })
            .catch((err) => {
              console.error("failed to persist scheduler user message", err);
            });
        }
      }
    }

    this.enqueue(job);
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
        temperature: this.config.temperature,
        topP: this.config.topP,
      };

      const result = await runTurn(turnInput, job.onEvent);

      const sessionId = job.sessionId || this.config.agentId;
      await this.config.messageRepository.append({ ...result.assistantMessage, sessionId });
      for (const toolMsg of result.toolMessages) {
        await this.config.messageRepository.append({ ...toolMsg, sessionId });
      }
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

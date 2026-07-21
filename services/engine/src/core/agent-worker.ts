import type { ChatMessage } from "@mindcloud/shared";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LLMProvider, LLMEvent } from "../provider/types.js";
import { runTurn, type TurnInput } from "./react/turn.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { IMessageRepository } from "../memory/repositories/types.js";
import type { ScheduledTaskJob } from "../scheduler/types.js";
import type { ChatMode } from "@mindcloud/shared";
import { ContextPipeline } from "../context/pipeline.js";
import { TopicTracker } from "../memory/topic/tracker.js";
import { CompressionQueue } from "../memory/topic/queue.js";
import { compressTopic } from "../memory/topic/compressor.js";
import { latestSummaries, removeCompressedTopic, writeCompressedTopic } from "../memory/topic/store.js";
import {
  DEFAULT_TOPIC_COMPRESSION_CONFIG,
  type TopicCompressionConfig,
} from "../memory/topic/types.js";

console.log("[agent-worker] module loaded");

export type AgentWorkerStatus = "idle" | "busy" | "paused";

export interface AgentWorkerConfig {
  agentId: string;
  model: string;
  provider: LLMProvider;
  tools: Tool[];
  workspaceDir: string;
  messageRepository: IMessageRepository;
  approve: (toolName: string, args: unknown, toolCallId?: string) => boolean | Promise<boolean>;
  temperature?: number;
  topP?: number;
  /** 已解析的 skill 内容（SKILL.md 全文），注入 system prompt */
  skillPrompts?: string[];
  /** 向量记忆索引（sidecar 可用时生效），用于跨会话语义检索 */
  memoryIndexer?: import("../memory/indexer.js").MemoryIndexer;
  embedder?: import("../provider/types.js").EmbedderProvider;
  imageProvider?: import("../provider/types.js").ImageGenProvider;
  /** 注入工具执行上下文的服务（如 subagent dispatcher），供 dispatch_subagent 等工具使用 */
  services?: ToolContext["services"];
  /** 上下文管线（可选注入，测试用）；默认按 DEFAULT_PIPELINE_CONFIG 构造 */
  contextPipeline?: ContextPipeline;
  /** 话题压缩配置（Phase 2）；缺省按 DEFAULT_TOPIC_COMPRESSION_CONFIG（开启） */
  topicCompression?: Partial<TopicCompressionConfig>;
}

export interface Job {
  id: string;
  messages: ChatMessage[];
  sessionId?: string;
  mode?: ChatMode;
  projectRoot?: string;
  /** 外部取消信号：已取消的排队 job 直接跳过；运行中在步骤边界中止 */
  signal?: AbortSignal;
  onEvent: (event: LLMEvent) => void;
  /** job 结束（成功或异常）时回调；err 为捕获到的异常，正常完成为 undefined */
  onDone?: (err?: unknown) => void;
  /** 危险工具（requiresApproval）的人工审批通道；未提供时危险工具一律拒绝 */
  onApprovalRequest?: (req: ApprovalRequest) => Promise<boolean>;
}

export interface ApprovalRequest {
  id: string;
  toolCallId?: string;
  toolName: string;
  arguments: unknown;
}

export class AgentWorker {
  status: AgentWorkerStatus = "idle";
  private queue: Job[] = [];
  private runningJob: Job | null = null;
  private pipeline: ContextPipeline;
  private topicConfig: TopicCompressionConfig;
  private topicTracker: TopicTracker;
  private compressionQueue: CompressionQueue;

  constructor(private config: AgentWorkerConfig) {
    this.pipeline = config.contextPipeline ?? new ContextPipeline();
    this.topicConfig = { ...DEFAULT_TOPIC_COMPRESSION_CONFIG, ...config.topicCompression };
    this.topicTracker = new TopicTracker(this.topicConfig);
    this.compressionQueue = new CompressionQueue(async (segment) => {
      if (segment.archiveOnly) {
        // 短话题：不调用 LLM，仅归档，保证热存储有界
        await this.config.messageRepository.archiveAndRemove(segment.messages.map((m) => m.id));
        return;
      }
      // 压缩失败不 fallback 主模型语义：异常由队列统一告警，原始消息留在热存储
      const compressed = await compressTopic(
        segment,
        this.config.provider,
        this.topicConfig.compressionModel || this.config.model,
      );
      await writeCompressedTopic(this.config.agentId, compressed);
      try {
        await this.config.messageRepository.archiveAndRemove(compressed.msgIds);
      } catch (err) {
        // 归档失败而压缩档已生效会导致"摘要 + 原文"重复注入：
        // 隔离压缩档（消息留在热存储，由队列告警记录），保证上下文不重复
        await removeCompressedTopic(this.config.agentId, compressed.topicId);
        throw err;
      }
    });
  }

  enqueue(job: Job): void {
    console.log("[agent-worker] enqueue, status:", this.status, "queue:", this.queue.length);
    this.queue.push(job);
    if (this.status === "idle") {
      console.log("[agent-worker] triggering processQueue");
      this.processQueue().catch((err) => {
        console.error("[agent-worker] processQueue failed:", err);
      });
    }
  }

  async runScheduledTask(job: ScheduledTaskJob): Promise<void> {
    if (job.sessionId) {
      for (const msg of job.messages) {
        if (msg.role === "user") {
          await this.config.messageRepository
            .append({
              // 保留原消息 id（与 ws 路径对齐）：话题压缩的 archiveAndRemove
              // 按 tracker 记录的 id 匹配热存储，另造 id 会导致永远无法归档
              id: msg.id || randomUUID(),
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

    let jobError: unknown;
    try {
      // 排队期间已被外部取消（如 subagent 前台超时）的 job 直接跳过
      if (job.signal?.aborted) {
        throw new Error("aborted");
      }
      console.log("[agent-worker] processQueue start, messages:", job.messages.length);
      const toolsMap = new Map(this.config.tools.map((t) => [t.name, t]));
      const toolDescriptions = this.config.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(t.parameters),
        },
      }));
      console.log("[agent-worker] tools:", toolDescriptions.length);

      const promptParts: string[] = [];
      if (this.config.skillPrompts && this.config.skillPrompts.length > 0) {
        promptParts.push(
          "# Skills\n\n" + this.config.skillPrompts.map((p) => p.trim()).join("\n\n---\n\n"),
        );
      }
      // L1 人格/skill 内容（pipeline 注入为 system 消息）
      const mindContext = promptParts.join("\n\n");

      // 跨会话语义检索：sidecar 可用时，取与当前用户消息最相关的历史消息补充上下文。
      // 失败静默降级；检索结果已在历史文件中，不会也不应被再次持久化。
      let retrieved: ChatMessage[] = [];
      const lastUser = [...job.messages].reverse().find((m) => m.role === "user");
      const lastUserText =
        lastUser?.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("") ?? "";

      const sessionId = job.sessionId || this.config.agentId;
      // 话题边界检测（Phase 2）：新话题开启时，旧话题送后台压缩队列
      if (lastUser) {
        const closed = this.topicTracker.onUserMessage(lastUser, sessionId);
        if (closed) this.compressionQueue.enqueue(closed);
      }

      // L5 话题摘要：最近压缩档注入组装（读取失败按空处理，不阻塞对话）
      let topicSummaries: string[] = [];
      if (this.topicConfig.enabled) {
        try {
          topicSummaries = await latestSummaries(this.config.agentId, this.topicConfig.hotMemoryCount);
        } catch (err) {
          console.warn("[topic] 压缩档读取失败，L5 按空处理", err);
        }
      }

      if (this.config.memoryIndexer && job.mode !== "code" && lastUser && lastUserText.trim()) {
        try {
          const hits = await this.config.memoryIndexer.search(this.config.agentId, lastUserText, 5);
          const known = new Set(job.messages.map((m) => m.id));
          const ids = hits.map((h) => h.id).filter((id) => !known.has(id));
          if (ids.length > 0) {
            const records = await this.config.messageRepository.getByIds(ids);
            retrieved = records.map(({ sessionId: _ignored, ...msg }) => msg);
          }
        } catch (err) {
          console.error("semantic retrieval failed", err);
        }
      }

      const messages = [
        ...retrieved,
        ...job.messages,
      ];

      const turnInput: TurnInput = {
        provider: this.config.provider,
        model: this.config.model,
        messages,
        tools: toolDescriptions,
        toolCtx: {
          agentId: this.config.agentId,
          workspaceDir: this.config.workspaceDir,
          projectRoot: job.projectRoot,
          tools: toolsMap,
          approve: async (name, args, toolCallId) => {
            // 全局策略门（当前生产环境放行）
            if (!(await this.config.approve(name, args, toolCallId))) return false;
            // 危险工具：必须走人工审批通道（交互式 WS 会话提供），无通道一律拒绝
            const tool = toolsMap.get(name);
            if (!tool?.requiresApproval) return true;
            if (!job.onApprovalRequest) return false;
            return job.onApprovalRequest({ id: randomUUID(), toolCallId, toolName: name, arguments: args });
          },
          emit: job.onEvent,
          services: this.config.services,
        },
        maxSteps: 5,
        temperature: this.config.temperature,
        topP: this.config.topP,
        signal: job.signal,
        contextPipeline: {
          pipeline: this.pipeline,
          input: {
            agentId: this.config.agentId,
            mindContext,
            sourceId: sessionId,
            topicSummaries,
          },
        },
      };

      console.log("[agent-worker] before runTurn, messages:", messages.length, "tools:", toolDescriptions.length);
      const result = await runTurn(turnInput, job.onEvent);
      console.log("[agent-worker] after runTurn, appended:", result.appended.length);

      // 按真实顺序持久化本轮新增的消息（每步 assistant + tool 消息）。
      // appended 由 runTurn 显式收集，与 pipeline 如何组装/截断输入无关，
      // 避免 tool 消息失去前置的 assistant toolCalls，也天然不含 system prompt。
      for (const msg of result.appended) {
        await this.config.messageRepository.append({ ...msg, sessionId });
      }

      // turn 消息并入当前话题；达到数量阈值则关闭并送压缩
      const closedByCount = this.topicTracker.onTurnAppended(result.appended, sessionId);
      if (closedByCount) this.compressionQueue.enqueue(closedByCount);

      // 向量索引（fire-and-forget）：本轮的用户输入与新增回复
      if (this.config.memoryIndexer) {
        const indexer = this.config.memoryIndexer;
        const agentId = this.config.agentId;
        const toIndex = [...(lastUser ? [lastUser] : []), ...result.appended];
        for (const msg of toIndex) {
          const text = msg.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("");
          void indexer.indexMessage(agentId, msg.id, text);
        }
      }
    } catch (err) {
      jobError = err;
      job.onEvent({ type: "text.delta", delta: `\nError: ${String(err)}` });
    } finally {
      this.runningJob = null;
      try {
        job.onDone?.(jobError);
      } catch (err) {
        console.error("job onDone callback failed", err);
      }
      if ((this.status as AgentWorkerStatus) !== "paused") {
        this.status = "idle";
        this.processQueue();
      }
    }
  }
}

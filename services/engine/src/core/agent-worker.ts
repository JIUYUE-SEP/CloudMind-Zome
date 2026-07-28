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
import { SECURITY_GUIDELINE } from "../context/security-guideline.js";
import { TopicTracker } from "../memory/topic/tracker.js";
import { CompressionQueue } from "../memory/topic/queue.js";
import { runCompressionTask } from "../memory/topic/compression-task.js";
import { addPendingSegment, removePendingSegment, saveTopicState } from "../memory/topic/state.js";
import { latestSummaries } from "../memory/topic/store.js";
import {
  normalizeTopicCompressionConfig,
  type TopicCompressionConfig,
  type TopicSegment,
} from "../memory/topic/types.js";
import {
  normalizeSemanticSearchConfig,
  SemanticRetriever,
  type SemanticSearchConfig,
} from "../context/semantic.js";
import type { SemanticMemory, TopicSummary } from "../context/layers.js";
import {
  loadSoul,
  loadMindChunks,
  retrieveMindChunks,
  type MindChunk,
} from "../mind/mind-files.js";
import { UnsupportedSchemaVersionError } from "../versioning.js";

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
  /** 语义检索配置（Phase 3）；缺省按 DEFAULT_SEMANTIC_SEARCH_CONFIG（开启） */
  semanticSearch?: Partial<SemanticSearchConfig>;
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
  private semanticConfig: SemanticSearchConfig;
  private semanticRetriever?: SemanticRetriever;

  constructor(private config: AgentWorkerConfig) {
    this.pipeline = config.contextPipeline ?? new ContextPipeline();
    this.topicConfig = normalizeTopicCompressionConfig(config.topicCompression);
    this.topicTracker = new TopicTracker(this.topicConfig);
    this.compressionQueue = new CompressionQueue(async (segment) => {
      await runCompressionTask(segment, {
        agentId: this.config.agentId,
        provider: this.config.provider,
        model: this.topicConfig.compressionModel || this.config.model,
        messageRepository: this.config.messageRepository,
      });
      // M-b：任务成功完成才清 pending；失败由队列捕获告警，pending 保留待对账
      await removePendingSegment(this.config.agentId, segment.topicId);
    });
    this.semanticConfig = normalizeSemanticSearchConfig(config.semanticSearch);
    if (config.memoryIndexer) {
      this.semanticRetriever = new SemanticRetriever(
        config.memoryIndexer,
        config.messageRepository,
        this.semanticConfig,
      );
    }
  }

  enqueue(job: Job): void {
    // P3 review Major-1：退役守卫——retire 后仍可能经"退役前解析的旧引用"
    // 入队（群聊 resolve→await listBySession→enqueue、scheduler 路径）；
    // 落在死队列的 job 永不处理、永不 settle，且 waitForIdle 以
    // queue.length>0 为条件永不返回 → 注册表 retiring 条目永不清除 →
    // 该 agent 全通道（私聊/群聊/scheduler/subagent）静默挂起直到重启。
    // 与 retire 同构：拒绝入队并立即 settle，调用方拿到明确错误而非挂起
    if (this.retired) {
      this.settleRetiredJob(job);
      return;
    }
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

  /**
   * 退役（P3-6，配置变更竞态）：进程内 worker 被替换时调用。
   * 与 pause（可 resume）语义分开——退役不可逆：
   * - 在途 job 继续跑完（结果正常落盘）；
   * - 排队未执行的 job 显式收尾：发 turn.end 终帧（前端"生成中"解锁）+
   *   onDone(aborted)——runAgentCollect 的 Promise 立即 settle，subagent
   *   前台调用不挂起；用户消息已落盘，前端提示重发。
   * 退役后 enqueue 被拒并立即 settle（P3 review Major-1 守卫）。
   */
  private retired = false;

  /** 退役 job 的统一收尾：终帧解锁 + onDone 明确错误（retire/enqueue 守卫共用） */
  private settleRetiredJob(job: Job): void {
    const err = new Error("worker retired: agent config changed");
    try {
      job.onEvent({ type: "text.delta", delta: "\n配置已变更，这条消息未处理，请重发。" });
      job.onEvent({ type: "turn.end" });
    } catch (eventErr) {
      console.error("retire: failed to emit terminal frames", eventErr);
    }
    try {
      job.onDone?.(err);
    } catch (doneErr) {
      console.error("retire: job onDone callback failed", doneErr);
    }
  }

  retire(): void {
    this.retired = true;
    this.status = "paused";
    const queued = this.queue.splice(0, this.queue.length);
    for (const job of queued) {
      this.settleRetiredJob(job);
    }
  }

  /**
   * 等待在途 job 跑完且队列清空（P3-6）：配置变更后新 worker 的创建等这个
   * 信号，保证两个 turn 不并发交错（FIFO 串行不变量）。
   */
  async waitForIdle(): Promise<void> {
    while (this.runningJob !== null || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * TopicTracker 交接（P3-6）：worker 被替换时，从 topic-state.json 的开放
   * 话题快照重建（P1-2/M-b 已按 step 落盘），新旧 worker 的话题边界不分叉。
   */
  restoreTopicOpen(messages: ChatMessage[], sourceId: string, sourceName?: string): void {
    this.topicTracker.restoreOpen(messages, sourceId, sourceName);
  }

  /** 优雅关停（P1-2）：等待压缩队列清空——进程退出前调用，避免 pending 压缩段被丢弃 */
  async drainCompression(): Promise<void> {
    await this.compressionQueue.drain();
  }

  /**
   * 话题状态落盘（P1-2）：在 turn 边界把开放话题快照写入 topic-state.json。
   * await 而非 fire-and-forget：保证进程收到退出信号时状态已落盘，也避免
   * 异步写句柄飘进测试清理/目录删除的窗口。写失败不阻断对话主流程，
   * 降级为改动前的重启孤儿行为。
   *
   * M-b：extraMessages 把 turn 内已按 step 落盘、尚未入 tracker 的消息 id
   * 并入快照（P1-6 尾巴：崩溃打在 onStepAppended 与 onTurnAppended 之间时，
   * 这些消息也在启动对账视野内）。
   */
  private async persistTopicState(extraMessages: ChatMessage[] = [], sourceId?: string): Promise<void> {
    if (!this.topicConfig.enabled) return;
    try {
      const open = this.topicTracker.openTopic;
      let merged = open;
      if (extraMessages.length > 0) {
        const extraIds = extraMessages.map((m) => m.id);
        merged = open
          ? { ...open, messageIds: [...open.messageIds, ...extraIds] }
          : {
              messageIds: extraIds,
              startedAt: extraMessages[0]!.createdAt,
              sourceId: sourceId ?? this.config.agentId,
            };
      }
      await saveTopicState(this.config.agentId, merged);
    } catch (err) {
      console.warn(`[topic] tracker 状态落盘失败（已跳过）：${this.config.agentId}`, err);
    }
  }

  /**
   * 压缩段入队（M-b）：入队即记状态——先落 pending 再入队；进程在任务执行前
   * 退出（desktop taskkill /F 无优雅关停）时由启动对账（reconcilePendingSegments）
   * 补压缩/补归档。pending 落盘失败不阻断入队（退化为修复前行为，warn 留痕）。
   */
  private async enqueueCompression(segment: TopicSegment): Promise<void> {
    try {
      await addPendingSegment(this.config.agentId, {
        topicId: segment.topicId,
        messageIds: segment.messages.map((m) => m.id),
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        sourceId: segment.sourceId,
        sourceName: segment.sourceName,
        archiveOnly: segment.archiveOnly ?? false,
      });
    } catch (err) {
      console.warn(`[topic] pending 段落盘失败（对账兜底退化）：${segment.topicId}`, err);
    }
    this.compressionQueue.enqueue(segment);
  }

  /**
   * 向量索引（fire-and-forget）：turn 的用户输入与新增消息。
   * 成功与异常（Minor-3）两条路径共用；与检索同开关，enabled=false 时全免
   */
  private indexTurnMessages(messages: ChatMessage[]): void {
    if (!this.config.memoryIndexer || !this.semanticConfig.enabled) return;
    const indexer = this.config.memoryIndexer;
    const agentId = this.config.agentId;
    for (const msg of messages) {
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      void indexer.indexMessage(agentId, msg.id, text);
    }
  }

  private async processQueue(): Promise<void> {
    if (this.status !== "idle" || this.queue.length === 0) return;
    this.status = "busy";
    const job = this.queue.shift()!;
    this.runningJob = job;

    let jobError: unknown;
    // catch 路径也要触达（P3 review Minor-3）：提升出 try 作用域
    let lastUser: ChatMessage | undefined;
    const stepPersisted: ChatMessage[] = [];
    const sessionId = job.sessionId || this.config.agentId;
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
      // SOUL.md 人格核心：L1 第一部分（固定前缀，缓存命中；缺失时默认模板兜底）
      promptParts.push(await loadSoul(this.config.agentId));
      if (this.config.skillPrompts && this.config.skillPrompts.length > 0) {
        promptParts.push(
          "# Skills\n\n" + this.config.skillPrompts.map((p) => p.trim()).join("\n\n---\n\n"),
        );
      }
      // L1 固定尾部（P2-6）：注入面元指引——"数据非指令"。固定文案，
      // 不随对话变化，跨轮字节稳定（缓存前缀不破）
      promptParts.push(SECURITY_GUIDELINE);
      // L1 人格/skill 内容（pipeline 注入为 system 消息；不含 MIND.md）
      const mindContext = promptParts.join("\n\n");

      lastUser = [...job.messages].reverse().find((m) => m.role === "user");
      const lastUserText =
        lastUser?.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("") ?? "";

      // 话题边界检测（Phase 2）：新话题开启时，旧话题送后台压缩队列
      if (lastUser) {
        const closed = this.topicTracker.onUserMessage(lastUser, sessionId);
        if (closed) await this.enqueueCompression(closed);
        // 话题状态落盘（P1-2，turn 起点）：此刻崩溃，重启对账能识别这个开放话题
        await this.persistTopicState();
      }

      // L5 话题摘要：最近压缩档注入组装（读取失败按空处理并明确告知，不静默降级）
      let retrievalFailed = false;
      let topicSummaries: TopicSummary[] = [];
      if (this.topicConfig.enabled) {
        try {
          topicSummaries = await latestSummaries(this.config.agentId, this.topicConfig.hotMemoryCount);
        } catch (err) {
          console.warn("[topic] 压缩档读取失败，L5 按空处理", err);
          retrievalFailed = true;
        }
      }

      // L4 语义检索（Phase 3 迁入 SemanticRetriever）：
      // 结果经 pipeline 注入（参与预算与降级），不再以消息位 prepend。
      // 失败不静默：retrievalFailed 让组装层尾随"记忆检索暂时不可用"的明确告知；
      // 检索结果已在历史文件中，不会也不应被再次持久化。
      let semanticMemories: SemanticMemory[] = [];
      if (this.semanticRetriever && job.mode !== "code" && lastUser && lastUserText.trim()) {
        try {
          const excludeIds = new Set(job.messages.map((m) => m.id));
          semanticMemories = await this.semanticRetriever.retrieve(
            this.config.agentId,
            lastUserText,
            excludeIds,
            sessionId,
          );
        } catch (err) {
          console.error("semantic retrieval failed", err);
          retrievalFailed = true;
        }
      }

      // MIND.md 经验检索（按需）：规则版按当前话题匹配相关块，
      // 经 pipeline 注入热上下文之后（伪装成 assistant 历史消息）。
      // 读取失败不静默——warn 留痕，本轮按无经验处理。
      let mindChunks: MindChunk[] = [];
      if (lastUser && lastUserText.trim()) {
        try {
          mindChunks = retrieveMindChunks(await loadMindChunks(this.config.agentId), lastUserText);
        } catch (err) {
          console.warn("[mind] MIND.md 读取失败，本轮不注入经验", err);
          // M-a 顺手统一（Minor-1）：高版本数据是明确错误而非"读取失败"，
          // 与 L4/L5 同一口径置 retrievalFailed，让用户/模型可感知
          if (err instanceof UnsupportedSchemaVersionError) retrievalFailed = true;
        }
      }

      const messages = [...job.messages];

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
        // step 级落盘（P1-6，review M8）：每完成一个 ReAct step 立即持久化，
        // 崩溃最多丢当前执行中的 step，不再丢整轮（秒~分钟窗口收窄到单步）。
        // appended 顺序与 turn 内真实顺序一致（assistant 先于其 tool 结果），
        // 且天然不含 system prompt / pipeline 注入内容
        onStepAppended: async (msgs) => {
          for (const msg of msgs) {
            await this.config.messageRepository.append({ ...msg, sessionId });
          }
          // M-b：step 落盘即并入开放话题快照——崩溃打在 onStepAppended 与
          // onTurnAppended 之间时（P1-6 尾巴），已落盘 step 也在对账视野内
          stepPersisted.push(...msgs);
          await this.persistTopicState(stepPersisted, sessionId);
        },
        contextPipeline: {
          pipeline: this.pipeline,
          input: {
            agentId: this.config.agentId,
            mindContext,
            sourceId: sessionId,
            topicSummaries,
            semanticMemories,
            mindChunks,
            retrievalFailed,
          },
        },
      };

      console.log("[agent-worker] before runTurn, messages:", messages.length, "tools:", toolDescriptions.length);
      const result = await runTurn(turnInput, job.onEvent);
      console.log("[agent-worker] after runTurn, appended:", result.appended.length);

      // 持久化已在 runTurn 内按 step 完成（onStepAppended），此处不再重复 append。

      // turn 消息并入当前话题；达到数量阈值则关闭并送压缩
      const closedByCount = this.topicTracker.onTurnAppended(result.appended, sessionId);
      if (closedByCount) await this.enqueueCompression(closedByCount);
      // 话题状态落盘（P1-2，turn 终点）
      await this.persistTopicState();

      // 向量索引（fire-and-forget）：本轮的用户输入与新增回复。
      // 与检索同开关：semanticSearch.enabled=false 时连索引成本也免去。
      // 保持 turn 级（P1-6）：索引每条消息一次 embed + sidecar upsert，step 级
      // 不会减少调用次数。异常 turn 的已落盘消息同样索引（Minor-3，见 catch）
      this.indexTurnMessages([...(lastUser ? [lastUser] : []), ...result.appended]);
    } catch (err) {
      jobError = err;
      // Minor-3：异常 turn 已按 step 落盘的消息必须并入话题体系——只进
      // stepPersisted 快照不进 tracker 会脱离话题（永不归档/压缩/索引，
      // 永久滞留热存储且每轮进上下文；P3-3 起每次 provider 抖动都产生一条）。
      // incomplete 半截消息同样入话题：它是用户上屏的真实内容，incomplete
      // 标记仅供排查，不影响其作为正常 assistant 消息归档/压缩/索引
      if (stepPersisted.length > 0) {
        const closedOnError = this.topicTracker.onTurnAppended(stepPersisted, sessionId);
        if (closedOnError) await this.enqueueCompression(closedOnError);
        await this.persistTopicState();
        this.indexTurnMessages([...(lastUser ? [lastUser] : []), ...stepPersisted]);
      }
      // abort 是用户主动中断（正常操作），不刷错误气泡；其余异常保留错误文本
      if (!job.signal?.aborted) {
        job.onEvent({ type: "text.delta", delta: `\nError: ${String(err)}` });
      }
      // P3-1（功能 M2）：异常路径补终帧。turn.end 唯一发出点在 runTurn 正常
      // 退出，provider/工具抛错、abort 都走不到，前端"生成中"永锁。
      // 语义：turn.end = 本轮生成终止（含异常终止）；能进 catch 说明 runTurn
      // 未发出，不存在双发；前端私聊（chat.ts onTurnEnd 复位 isStreaming）与
      // 群聊（useGroupChatStream closeSlot）现有逻辑直接生效，协议不动。
      job.onEvent({ type: "turn.end" });
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

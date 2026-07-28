import { logger } from "../logger.js";
import type { ChatMessage } from "@mindcloud/shared";
import { createLayers } from "./layers.js";
import type { ToolSchema, SemanticMemory, TopicSummary, ContextLayers } from "./layers.js";
import type { MindChunk } from "../mind/mind-files.js";
import { assembleMessages } from "./assembler.js";
import { selectNextStep } from "./downgrade.js";
import { CONFIDENCE_DROP } from "./recall.js";
import { getTokenCounter, type TokenCounter } from "./token-counter.js";

export interface ContextPipelineConfig {
  /** 上下文窗口总预算，默认 80000 */
  maxContextTokens: number;
  /** 预留给输出的比例，默认 0.1（10% buffer，宁可保守不可溢出） */
  reserveRatio: number;
}

export const DEFAULT_PIPELINE_CONFIG: ContextPipelineConfig = {
  maxContextTokens: 80_000,
  reserveRatio: 0.1,
};

export interface AssembleInput {
  agentId: string;
  /** 当前会话完整历史（L3） */
  history: ChatMessage[];
  /** L1 人格文件内容 */
  mindContext: string;
  /** L6 工具定义（Phase 1 全部视为 L6-core，永不裁剪） */
  tools: ToolSchema[];
  /** L2 @提及提醒 */
  mentionDesc?: string;
  /** 当前场景 ID（session/group；Phase 3 跨场景标注与多轮去重分键使用） */
  sourceId: string;
  sourceName?: string;
  /** L5 话题摘要（最近压缩档的结构化条目，已按时间倒序） */
  topicSummaries?: TopicSummary[];
  /** L4 语义检索结果（已按 score 降序，降级时优先保留高相关） */
  semanticMemories?: SemanticMemory[];
  /** MIND.md 经验检索命中块（agent-worker 已按当前话题检索；注入热上下文之后，不参与降级） */
  mindChunks?: MindChunk[];
  /** 记忆检索本轮失败：组装时尾随 system 消息明确告知（诚实透明） */
  retrievalFailed?: boolean;
}

export interface AssembleResult {
  messages: ChatMessage[];
  /** 降级后的工具列表（L6-ext 裁剪在此生效；Phase 1 恒等于输入） */
  tools: ToolSchema[];
}

/** 多轮去重状态的会话数上限（FIFO 逐出最旧会话，防长驻进程无界增长） */
const MAX_DEDUP_SESSIONS = 64;

/**
 * ContextPipeline v2（最终设计）：L1-L6 组装 + 降级循环 + 多轮去重。
 * 每轮 assemble：先按当前层内容组装并计数，超预算则执行下一个降级步骤
 * （L5 → L4 → L6-ext → L3），直到满足预算或无可再降（兜底按现状返回）。
 *
 * 多轮去重（设计决策 5）：同一会话（sourceId）已注入的记忆/摘要 id 记录在案，
 * 后续轮次不再注入；只标记"实际进了 messages"的条目——被降级丢弃的不误标。
 */
export class ContextPipeline {
  private config: ContextPipelineConfig;
  /** 会话 → 已注入条目 id（`mem:`/`topic:` 前缀防跨类碰撞） */
  private injectedBySource = new Map<string, Set<string>>();

  constructor(
    config: Partial<ContextPipelineConfig> = {},
    private counter: TokenCounter = getTokenCounter(),
  ) {
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
  }

  /** 可用预算 = 窗口总量 × (1 - 预留比例) */
  get budgetTokens(): number {
    return Math.floor(this.config.maxContextTokens * (1 - this.config.reserveRatio));
  }

  private seenSet(sourceId: string): Set<string> {
    let seen = this.injectedBySource.get(sourceId);
    if (!seen) {
      if (this.injectedBySource.size >= MAX_DEDUP_SESSIONS) {
        // Map 按插入序迭代：删最旧的会话条目
        const oldest = this.injectedBySource.keys().next().value;
        if (oldest !== undefined) this.injectedBySource.delete(oldest);
      }
      seen = new Set<string>();
      this.injectedBySource.set(sourceId, seen);
    }
    return seen;
  }

  /** 只记录本轮实际注入（降级后仍在层内）的条目 */
  private markInjected(sourceId: string, layers: ContextLayers): void {
    if (layers.l4.length === 0 && layers.l5.length === 0) return;
    const seen = this.seenSet(sourceId);
    for (const m of layers.l4) seen.add(`mem:${m.id}`);
    for (const t of layers.l5) seen.add(`topic:${t.id}`);
  }

  async assemble(input: AssembleInput): Promise<AssembleResult> {
    const seen = this.seenSet(input.sourceId);
    const layers = createLayers({
      l1: input.mindContext,
      l2: input.mentionDesc,
      l3: [...input.history],
      // 置信度控制（设计决策 4）：≤ 0.5 直接丢弃；多轮去重：已注入 id 跳过
      l4: (input.semanticMemories ?? []).filter(
        (m) => m.score > CONFIDENCE_DROP && !seen.has(`mem:${m.id}`),
      ),
      l5: (input.topicSummaries ?? []).filter((t) => !seen.has(`topic:${t.id}`)),
      // MIND.md 经验块：已在上游按话题检索，直接进层（Phase 1 不去重、不降级）
      mind: [...(input.mindChunks ?? [])],
      l6Core: [...input.tools],
      // Phase 1 决策：现有 7 个内置工具全部为 L6-core；L6-ext 预留（MCP 接入后启用）
      l6Ext: [],
    });

    for (;;) {
      const messages = assembleMessages(layers, { retrievalFailed: input.retrievalFailed });
      const tools = [...layers.l6Core, ...layers.l6Ext];
      const total =
        this.counter.countMessages(messages) + this.counter.countTools(tools);
      if (total <= this.budgetTokens) {
        this.markInjected(input.sourceId, layers);
        return { messages, tools };
      }
      const step = selectNextStep(layers);
      if (!step) {
        // 兜底：无可再降，按现状返回（设计文档：放弃，返回）
        // M3：兜底是"记忆静默退化"的最坏形态，必须 warn 留痕
        logger.warn(
          `[ContextPipeline] agent=${input.agentId} 预算不足且无可再降层，按现状返回：` +
            `total=${total} budget=${this.budgetTokens} l3=${layers.l3.length}`,
        );
        this.markInjected(input.sourceId, layers);
        return { messages, tools };
      }
      step.apply(layers);
      // M3：每步降级打 debug——哪一层被降、降后各层规模、当前预算使用
      logger.debug(
        `[ContextPipeline] agent=${input.agentId} 降级 ${step.name}：` +
          `total=${total} budget=${this.budgetTokens}，降后 ` +
          `l3=${layers.l3.length} l5=${layers.l5.length} l4=${layers.l4.length} l6Ext=${layers.l6Ext.length}`,
      );
    }
  }
}

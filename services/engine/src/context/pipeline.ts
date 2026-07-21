import type { ChatMessage } from "@mindcloud/shared";
import { createLayers } from "./layers.js";
import type { ToolSchema, SemanticMemory } from "./layers.js";
import { assembleMessages } from "./assembler.js";
import { selectNextStep } from "./downgrade.js";
import { getTokenCounter, type TokenCounter } from "./token-counter.js";

export interface ContextPipelineConfig {
  /** 上下文窗口总预算，默认 80000 */
  maxContextTokens: number;
  /** 预留给输出的比例，默认 0.1（10% buffer，宁可保守不可溢出） */
  reserveRatio: number;
  /** 注入最近压缩档数量（Phase 2 使用，Phase 1 预留） */
  hotMemoryCount: number;
  /** 语义检索候选数（Phase 3 使用，Phase 1 预留） */
  semanticCandidateCount: number;
}

export const DEFAULT_PIPELINE_CONFIG: ContextPipelineConfig = {
  maxContextTokens: 80_000,
  reserveRatio: 0.1,
  hotMemoryCount: 2,
  semanticCandidateCount: 10,
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
  /** 当前场景 ID（session/group；Phase 3 跨场景标注使用） */
  sourceId: string;
  sourceName?: string;
  /** L5 话题摘要（Phase 2：最近压缩档的渲染文本，已按时间倒序） */
  topicSummaries?: string[];
  /** L4 语义检索结果（Phase 3：已按 score 降序，降级时优先保留高相关） */
  semanticMemories?: SemanticMemory[];
}

export interface AssembleResult {
  messages: ChatMessage[];
  /** 降级后的工具列表（L6-ext 裁剪在此生效；Phase 1 恒等于输入） */
  tools: ToolSchema[];
}

/**
 * ContextPipeline v2（Phase 1）：L1-L6 组装 + 降级循环。
 * 每轮 assemble：先按当前层内容组装并计数，超预算则执行下一个降级步骤
 * （L5 → L4 → L6-ext → L3），直到满足预算或无可再降（兜底按现状返回）。
 */
export class ContextPipeline {
  private config: ContextPipelineConfig;

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

  async assemble(input: AssembleInput): Promise<AssembleResult> {
    const layers = createLayers({
      l1: input.mindContext,
      l2: input.mentionDesc,
      l3: [...input.history],
      l4: input.semanticMemories ?? [],
      l5: input.topicSummaries ?? [],
      l6Core: [...input.tools],
      // Phase 1 决策：现有 7 个内置工具全部为 L6-core；L6-ext 预留（MCP 接入后启用）
      l6Ext: [],
    });

    for (;;) {
      const messages = assembleMessages(layers);
      const tools = [...layers.l6Core, ...layers.l6Ext];
      const total =
        this.counter.countMessages(messages) + this.counter.countTools(tools);
      if (total <= this.budgetTokens) {
        return { messages, tools };
      }
      const step = selectNextStep(layers);
      if (!step) {
        // 兜底：无可再降，按现状返回（设计文档：放弃，返回）
        // M3：兜底是"记忆静默退化"的最坏形态，必须 warn 留痕
        console.warn(
          `[ContextPipeline] agent=${input.agentId} 预算不足且无可再降层，按现状返回：` +
            `total=${total} budget=${this.budgetTokens} l3=${layers.l3.length}`,
        );
        return { messages, tools };
      }
      step.apply(layers);
      // M3：每步降级打 debug——哪一层被降、降后各层规模、当前预算使用
      console.debug(
        `[ContextPipeline] agent=${input.agentId} 降级 ${step.name}：` +
          `total=${total} budget=${this.budgetTokens}，降后 ` +
          `l3=${layers.l3.length} l5=${layers.l5.length} l4=${layers.l4.length} l6Ext=${layers.l6Ext.length}`,
      );
    }
  }
}

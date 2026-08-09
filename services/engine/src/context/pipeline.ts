import { logger } from "../logger.js";
import type { ChatMessage } from "@mindcloud/shared";
import { createLayers } from "./layers.js";
import type { ToolSchema, SemanticMemory, TopicSummary, ContextLayers } from "./layers.js";
import type { MindChunk } from "../mind/mind-files.js";
import { assembleMessages, systemMessage } from "./assembler.js";
import { selectNextStep } from "./downgrade.js";
import {
  CONFIDENCE_DROP,
  memoryToMessage,
  topicToMessage,
  mindToMessage,
  retrievalFailedMessage,
} from "./recall.js";
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

/** 上下文窗口缺省（水位主裁 W 与 pipeline 预算同值：80000，改动三缺省落点） */
export const DEFAULT_CONTEXT_WINDOW = DEFAULT_PIPELINE_CONFIG.maxContextTokens;

/**
 * S6：旧水位提醒（system）的过滤特征——文本以该前缀开头。水位提醒是"当回合"
 * 的数字快照，跨回合重放会拿过期百分比误导模型；盘上保留不删，仅组装 L3 时
 * 不再带入新回合。
 */
export const WATERMARK_REMINDER_PREFIX = "[系统提醒] 本轮上下文已用";

function isWatermarkReminder(m: ChatMessage): boolean {
  if (m.role !== "system") return false;
  const text = m.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return text.startsWith(WATERMARK_REMINDER_PREFIX);
}

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
  /**
   * 规程自动恢复（阶段 5 二期）：前一话题用过的技能正文，以尾部 system 消息
   * 附带注入——不进 L1 固定前缀（保缓存前缀），语义属"规程数据通告"而非人格/记忆
   */
  skillRestore?: string;
  /** 换班交接书置顶注入（续跑）：固定 system 消息置于 L1 之前，永不参与降级 */
  handoffPinned?: string;
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

  /** 当前窗口配置（H2 热更同步的读值入口） */
  get maxContextTokens(): number {
    return this.config.maxContextTokens;
  }

  /**
   * H2（pipeline 热更一致化）：compute 型号表 / agent 配置热更后，由调用方
   * （agent-worker）逐回合同步窗口。只改 config 不重建实例——重建会丢
   * injectedBySource 多轮去重状态。值未变返回 false（幂等，避免无效日志）。
   * F3：只接受正有限数；非正数/NaN/Infinity 拒绝并 warn 留痕，预算保持不动。
   */
  syncMaxContextTokens(value: number): boolean {
    if (this.config.maxContextTokens === value) return false;
    if (!Number.isFinite(value) || value <= 0) {
      logger.warn(
        { value },
        "[ContextPipeline] syncMaxContextTokens 拒绝非法窗口值（需为正有限数），保持现有预算",
      );
      return false;
    }
    this.config.maxContextTokens = value;
    return true;
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
      // S6：历史中的旧水位提醒不随新回合重放（防过期水位数字误导；文件保留不动）
      l3: input.history.filter((m) => !isWatermarkReminder(m)),
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

    // 单次 assemble 的统一时间基准：增量计数的渲染文本与最终组装必须是同一份，
    // 否则"计数的文本"和"发出的文本"可能差一个相对时间渲染边界（M3 增量计数）
    const now = Date.now();

    // —— 增量计数初始化（质量 review M3）——
    // countMessages 对每条消息独立累加（overhead+role+content+toolCalls），与
    // 顺序/归并无关，因此总量 = 各层条目计数之和；降级步骤只移除条目，每步
    // 增量减掉被移除项即可，不再每步 O(n) 全量重算（完整降级序列 402ms → ~单次）。
    const countOne = (m: ChatMessage): number => this.counter.countMessages([m]);
    const sum = (nums: number[]): number => nums.reduce((a, b) => a + b, 0);
    const l3Tokens = layers.l3.map(countOne);
    // l4 入层时已按 CONFIDENCE_DROP 过滤（≤0.5 不入层），memoryToMessage 不会返回 null
    const l4Tokens = layers.l4.map((m) => countOne(memoryToMessage(m, now)!));
    const l5Tokens = layers.l5.map((t) => countOne(topicToMessage(t, now)));
    // 固定部分（L1/L2 前缀、MIND、规程恢复、检索失败告知）不参与降级，只计一次；
    // 构造条件与 assembleMessages 逐条对应，口径一致
    const fixedMessages: ChatMessage[] = [];
    // 置顶注入（交接书）与 L1/L2 等固定层同口径计入预算：永不降级
    if (input.handoffPinned) fixedMessages.push(systemMessage(input.handoffPinned));
    if (layers.l1.trim()) fixedMessages.push(systemMessage(layers.l1));
    if (layers.l2?.trim()) fixedMessages.push(systemMessage(layers.l2));
    if (layers.mind.length > 0) fixedMessages.push(mindToMessage(layers.mind, now));
    if (input.skillRestore) fixedMessages.push(systemMessage(input.skillRestore));
    if (input.retrievalFailed) fixedMessages.push(retrievalFailedMessage());
    const fixedTokens = sum(fixedMessages.map(countOne));

    let tools = [...layers.l6Core, ...layers.l6Ext];
    let toolsTokens = this.counter.countTools(tools);
    let total = fixedTokens + sum(l3Tokens) + sum(l4Tokens) + sum(l5Tokens) + toolsTokens;

    for (;;) {
      if (total <= this.budgetTokens) {
        this.markInjected(input.sourceId, layers);
        return {
          messages: assembleMessages(layers, {
            now,
            retrievalFailed: input.retrievalFailed,
            skillRestore: input.skillRestore,
            handoffPinned: input.handoffPinned,
          }),
          tools,
        };
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
        return {
          messages: assembleMessages(layers, {
            now,
            retrievalFailed: input.retrievalFailed,
            skillRestore: input.skillRestore,
            handoffPinned: input.handoffPinned,
          }),
          tools,
        };
      }
      const before = total;
      step.apply(layers);
      // 增量更新总量（与全量重算逐项对应）：
      if (step.name === "l5:drop-oldest") {
        // l5 时间倒序（最新在前），drop-oldest 移除末尾（最旧）一条
        total -= l5Tokens.pop() ?? 0;
      } else if (step.name.startsWith("l4:")) {
        // l4 keep-N / drop 保留前部（高相关），移除尾部
        total -= sum(l4Tokens.splice(layers.l4.length));
      } else if (step.name.startsWith("l3:")) {
        // truncateHotContext 保留尾部 keep 条并连带丢弃头部孤儿 tool，移除的是头部
        total -= sum(l3Tokens.splice(0, l3Tokens.length - layers.l3.length));
      } else if (step.name.startsWith("l6ext:")) {
        // tools 是整组 JSON 编码，按条拆分不保证与整组一致——仅 l6ext 两步重算
        // （计算对象就是降级后的整组，与全量重算逐字节一致）；其余步骤复用缓存
        tools = [...layers.l6Core, ...layers.l6Ext];
        const next = this.counter.countTools(tools);
        total += next - toolsTokens;
        toolsTokens = next;
      }
      // M3：每步降级打 debug——哪一层被降、降后各层规模、当前预算使用
      logger.debug(
        `[ContextPipeline] agent=${input.agentId} 降级 ${step.name}：` +
          `total=${before} budget=${this.budgetTokens}，降后 ` +
          `l3=${layers.l3.length} l5=${layers.l5.length} l4=${layers.l4.length} l6Ext=${layers.l6Ext.length}`,
      );
    }
  }
}

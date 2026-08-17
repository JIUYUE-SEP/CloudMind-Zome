import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent, LLMChatParams } from "../../provider/types.js";
import { randomUUID } from "node:crypto";
import { executeLoopStep, StepStreamError, type StepInput, type StepResult } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  WATERMARK_REMINDER_PREFIX,
  type AssembleInput,
  type ContextPipeline,
} from "../../context/pipeline.js";
import { TOOL_RESULT_BUDGET_RATIO } from "../../context/truncate.js";
import { getTokenCounter } from "../../context/token-counter.js";
import { stripUnansweredToolCalls } from "../../context/history-sanitize.js";
import { logger } from "../../logger.js";
import { HANDOFF_DEFAULT_MAX_SHIFTS } from "../../handoff/types.js";

/** 撞顶兜底（真机实锤：连续工具调用后回合静默结束）：追加一次无工具总结的 system 提示 */
export const MAX_STEPS_SUMMARY_HINT =
  "工具调用步数已用完（异常空转保护），请根据已获得的信息直接给出最终回复，不要再调用工具";
/** 水位撞顶兜底（改动一）：语义为「水位撞顶」，与保险丝文案可区分 */
export const CONTEXT_WATERMARK_SUMMARY_HINT =
  "本轮上下文已接近窗口上限（水位撞顶），请根据已获得的信息直接给出最终回复，不要再调用工具";
/** 兜底总结也失败/空文本时的最终兜底回复——回合永远要有 assistant 回复，绝不静默 */
export const MAX_STEPS_FALLBACK_REPLY = "我查了很多资料但没能整理好答案，请再问我一次";
/** 水位撞顶兜底也失败/空文本时的最终兜底回复（与保险丝文案可区分） */
export const CONTEXT_WATERMARK_FALLBACK_REPLY =
  "本轮上下文已接近窗口上限，未能整理好答案，请再问我一次";

/** 交接书消息载体前缀（水位撞顶=换班移交：换班不死） */
export const HANDOFF_BOOK_PREFIX = "[交接书]";

/**
 * 交接书写作指引（件1 三分法）：瘦身写作调用的 system 提示。
 * 强制三节——任务目的/已完成/未来方向，体积约束写进指引。
 */
export const HANDOFF_WRITING_GUIDANCE =
  "你是换班交接书的写作助手。请严格按以下三节写交接书内容，供下一棒直接继续执行：\n" +
  "【任务目的】用户最初要干什么（原话锚定，防目标漂移）；\n" +
  "【已完成】做了什么+实质发现（每项一句话+指针id；含「已确认无关」清单；若上一棒有交接书，把上一棒的已完成滚动并入，防重复劳动）；\n" +
  "【未来方向】下一步做什么、从哪个具体动作/id 动手（防重新规划）。\n" +
  "体积约束：每项一句话；发现清单超长时自行合并精简；不要重复汇报已有进展。";

/** 本棒足迹机械附（件2）：单条 name+参数上限 / 足迹清单总长上限 */
const HANDOFF_FOOTPRINT_ITEM_MAX = 80;
const HANDOFF_FOOTPRINT_TOTAL_MAX = 500;

/** 交接书机械上限（K3）：上一棒交接书 / 兜底总结素材 / 写作产出内容 */
const HANDOFF_PREV_BOOK_MAX = 3000;
const HANDOFF_SUMMARY_MAX = 2000;
const HANDOFF_WRITTEN_MAX = 3000;

/** R2（B 方案不变量）：runTurn 型号 ≠ provider.defaultModel 的 warn 去重（每 provider+型号一次） */
const routerModelMismatchWarned = new Set<string>();

/**
 * 上下文水位主裁（改动一）：硬编码产品语义，不开放配置。
 * 0.7 = 提醒线：每回合至多追加一条 system 提醒后继续；0.9 = 撞顶线：跳出循环走兜底。
 */
const CONTEXT_WARN_RATIO = 0.7;
const CONTEXT_STOP_RATIO = 0.9;

type SummaryReason = "max_steps" | "watermark";

export interface TurnInput {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  toolCtx: ToolExecutionContext;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /**
   * 上下文窗口 W（改动一）：调用方按 agent 配置的 providerId + modelId 查型号表
   * 传入（改动三 helper）；缺省 80_000（与 pipeline 缺省同值）。
   */
  contextWindow?: number;
  /**
   * 换班移交（交接书）：撞顶时给交接书盖的棒次戳与保险丝上限。
   * 首棒缺省 shift=1、maxShifts=HANDOFF_DEFAULT_MAX_SHIFTS；
   * 续跑由调度方（ws 层）显式传入下一棒次与同一保险丝上限；
   * bookText=上一棒交接书（控制面权威，K1 优先于历史窗口扫描）。
   */
  handoff?: { shift: number; maxShifts: number; bookText?: string };
  /**
   * 任务原消息解析（K1）：优先取 session 首条用户消息（repository 查询，
   * 不受续跑最近 20 条窗口限制）；查不到时退回窗口内首条用户消息。
   */
  resolveSessionTaskText?: () => Promise<string | undefined>;
  /** 外部取消信号（如 subagent 前台超时）：在步骤边界检查并中止本轮 */
  signal?: AbortSignal;
  /**
   * ContextPipeline v2：存在时，本轮 messages/tools 先经 pipeline.assemble
   * 组装（含超预算降级），替换直接 messages 传递。
   */
  contextPipeline?: {
    pipeline: ContextPipeline;
    input: Omit<AssembleInput, "history" | "tools">;
  };
  /**
   * step 级落盘钩子（P1-6，review M8）：每完成一个 ReAct step（assistant 输出 +
   * 该步工具调用与结果）即以 [assistant, ...tools] 顺序回调一次。崩溃最多丢
   * 当前正在执行的 step，不再丢整轮。抛错即中止本轮（热存储只含完整 step）。
   * 水位 70% 提醒（system 消息）在插入时以单条回调一次，保证历史留痕。
   */
  onStepAppended?: (messages: ChatMessage[]) => Promise<void>;
  /**
   * LLM 请求钩子（P8b 事件缝，全链路可选）：透传到本回合每一次
   * executeLoopStep（主循环步 / 兜底总结 / 交接书写作间），step 层在
   * provider.chat 前调用。bare runTurn 调用方（傀儡/测试/压缩）不接，
   * 缺省零开销零行为变化。
   */
  onLLMRequest?: (params: LLMChatParams) => Promise<void>;
}

export interface TurnResult {
  messages: ChatMessage[];
  assistantMessage: ChatMessage;
  toolMessages: ChatMessage[];
  /**
   * 本轮按序新增的全部消息（assistant + tool）。P1-6 起持久化由
   * onStepAppended 按 step 落盘，本字段仅供话题 tracker / 向量索引使用。
   * 水位 70% 提醒（system）也计入，随话题关闭归档。
   */
  appended: ChatMessage[];
  /** 本轮是否水位撞顶（换班移交语义：撞顶不静默死亡，产出交接书） */
  watermarkStopped: boolean;
  /** 交接书消息载体（撞顶时产出；作为 system 消息落历史并返回，供置顶注入） */
  handoffBook?: ChatMessage;
  /** 交接书棒次/保险丝（与 handoffBook 同源；首棒 1/3） */
  handoffShift?: number;
  handoffMaxShifts?: number;
  /** 撞顶时水位 U/W（交接书元信息与日志） */
  watermarkUsed?: number;
  watermarkWindow?: number;
}

function assistantText(message: ChatMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** assistant 消息是否有可落盘内容（文本/思考/工具调用任一非空）——P1-2 空 content 不落盘 */
function hasAssistantContent(message: ChatMessage): boolean {
  if ((message.toolCalls?.length ?? 0) > 0) return true;
  return message.content.some((c) =>
    (c.type === "text" && Boolean(c.text)) || (c.type === "think" && Boolean(c.think)),
  );
}

interface HandoffFootprintCall {
  name: string;
  arguments?: unknown;
}

/** 足迹单条：name(参数 JSON)；超 80 字符截断（件2） */
function formatFootprintItem(call: HandoffFootprintCall): string {
  let argText = "";
  if (call.arguments !== undefined && call.arguments !== null) {
    try {
      argText = JSON.stringify(call.arguments);
    } catch {
      argText = "";
    }
  }
  let item = argText ? `${call.name}(${argText})` : `${call.name}()`;
  if (item.length > HANDOFF_FOOTPRINT_ITEM_MAX) {
    item = item.slice(0, HANDOFF_FOOTPRINT_ITEM_MAX - 1) + "…";
  }
  return item;
}

/** 本棒足迹清单（无工具调用返回 undefined）：机械流水账，总长截 500 字符（件2） */
function formatHandoffFootprint(
  calls: readonly HandoffFootprintCall[],
): string | undefined {
  if (calls.length === 0) return undefined;
  let line = calls.map(formatFootprintItem).join("；");
  if (line.length > HANDOFF_FOOTPRINT_TOTAL_MAX) {
    line = line.slice(0, HANDOFF_FOOTPRINT_TOTAL_MAX - 1) + "…";
  }
  return line;
}

/** 交接书文本机械截断（P2：保尾切头 + 头部截断标注）：
 * 三分法交接书【未来方向】在尾部最重要——截断时保留尾部，并标注头部已截，
 * 避免下一棒拿到「有开头没方向」的半截书。 */
const HANDOFF_TRUNCATE_PREFIX = "…（头部已截断）";
function truncateHandoffText(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - HANDOFF_TRUNCATE_PREFIX.length;
  if (keep <= 0) return HANDOFF_TRUNCATE_PREFIX.slice(0, max);
  return HANDOFF_TRUNCATE_PREFIX + text.slice(-keep);
}

function makeFallbackReply(
  emit: (event: LLMEvent) => void,
  reason: SummaryReason = "max_steps",
): ChatMessage {
  const text = reason === "watermark" ? CONTEXT_WATERMARK_FALLBACK_REPLY : MAX_STEPS_FALLBACK_REPLY;
  const message: ChatMessage = {
    id: `msg_${randomUUID()}`,
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
  // 兜底文本不经 provider，需手动补流式帧，前端才不会空白等待
  emit({ type: "text.delta", delta: text });
  return message;
}

/**
 * 撞顶兜底总结调用：maxSteps 全部消耗在工具循环或水位撞顶（最后一次仍是
 * tool_use）时，在 messages 尾部追加 system 提示、tools 传空，强制模型产出最终文本。
 * 调用失败/违规工具调用/空文本 → 产出兜底回复文本（绝不静默）。
 */
async function runMaxStepsSummary(
  input: TurnInput,
  messages: ChatMessage[],
  maxToolResultTokens: number | undefined,
  emit: (event: LLMEvent) => void,
  reason: SummaryReason,
): Promise<ChatMessage> {
  const hintText =
    reason === "watermark" ? CONTEXT_WATERMARK_SUMMARY_HINT : MAX_STEPS_SUMMARY_HINT;
  const hint: ChatMessage = {
    id: `msg_${randomUUID()}`,
    role: "system",
    content: [{ type: "text", text: hintText }],
    createdAt: new Date().toISOString(),
  };
  let result: StepResult;
  try {
    result = await executeLoopStep(
      {
        provider: input.provider,
        model: input.model,
        messages: [...messages, hint],
        // 不带工具：模型必须产出文本；即便模型违规发 tool.call，
        // 空工具表也只会得到 "Unknown tool" 错误结果（防御）
        tools: [],
        toolCtx: { ...input.toolCtx, tools: new Map() },
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        topP: input.topP,
        maxToolResultTokens,
        signal: input.signal,
        onLLMRequest: input.onLLMRequest,
      },
      emit,
    );
  } catch {
    return makeFallbackReply(emit, reason);
  }
  if (result.stopReason === "tool_use" || assistantText(result.assistantMessage).length === 0) {
    return makeFallbackReply(emit, reason);
  }
  return result.assistantMessage;
}

/** 任务原消息截断上限（件3 材料①） */
const HANDOFF_TASK_TEXT_MAX = 2000;

/** 本 session 首条用户消息文本（截 2000 字符；无用户消息返回 undefined） */
function firstUserTaskText(messages: ChatMessage[]): string | undefined {
  const first = messages.find((m) => m.role === "user");
  if (!first) return undefined;
  const text = first.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return text.slice(0, HANDOFF_TASK_TEXT_MAX);
}

/** 最近的上一棒交接书全文（供滚动并入；无则返回 undefined） */
function lastHandoffBookText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "system") continue;
    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text.startsWith(HANDOFF_BOOK_PREFIX)) return text;
  }
  return undefined;
}

/**
 * 瘦身写作间（件3）：独立小调用写交接书三分法内容，与全量兜底回复调用分离。
 * system = 写作指引；user = 材料包四样（任务原消息/上一棒交接书/本棒足迹/本棒回顾）。
 * K1：任务原消息优先 repository 解析（session 首条用户消息），查不到退回窗口内首条；
 * 上一棒交接书优先 handoff.bookText（控制面权威），窗口扫描仅作兜底。
 * K3：上一棒交接书截 3000、本棒回顾素材截 2000、写作产出截 3000（省略号标注）。
 * 单步（maxSteps=1 语义）、无工具；内部调用不向用户流式转发（no-op emit）。
 * 失败/空文本/违规工具调用/abort → undefined（调用方降级为兜底总结文本直接装入）。
 */
async function writeHandoffBookContent(
  input: TurnInput,
  summaryText: string,
  footprint: string | undefined,
): Promise<string | undefined> {
  const sections: string[] = [];
  let taskText: string | undefined;
  if (input.resolveSessionTaskText) {
    try {
      const resolved = await input.resolveSessionTaskText();
      if (resolved !== undefined) taskText = resolved.slice(0, HANDOFF_TASK_TEXT_MAX);
    } catch {
      taskText = undefined;
    }
  }
  if (taskText === undefined) taskText = firstUserTaskText(input.messages);
  if (taskText !== undefined) sections.push(`【任务原消息】\n${taskText}`);
  const prevBook = input.handoff?.bookText ?? lastHandoffBookText(input.messages);
  if (prevBook !== undefined) {
    sections.push(`【上一棒交接书】\n${truncateHandoffText(prevBook, HANDOFF_PREV_BOOK_MAX)}`);
  }
  if (footprint !== undefined) sections.push(`【本棒足迹】\n${footprint}`);
  sections.push(`【本棒回顾】\n${truncateHandoffText(summaryText, HANDOFF_SUMMARY_MAX)}`);
  const guidance: ChatMessage = {
    id: `msg_${randomUUID()}`,
    role: "system",
    content: [{ type: "text", text: HANDOFF_WRITING_GUIDANCE }],
    createdAt: new Date().toISOString(),
  };
  const material: ChatMessage = {
    id: `msg_${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: sections.join("\n\n") }],
    createdAt: new Date().toISOString(),
  };
  try {
    const result = await executeLoopStep(
      {
        provider: input.provider,
        model: input.model,
        messages: [guidance, material],
        tools: [],
        toolCtx: { ...input.toolCtx, tools: new Map() },
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        topP: input.topP,
        signal: input.signal,
        onLLMRequest: input.onLLMRequest,
      },
      () => {},
    );
    const text = assistantText(result.assistantMessage);
    if (result.stopReason === "tool_use" || text.length === 0) return undefined;
    return truncateHandoffText(text, HANDOFF_WRITTEN_MAX);
  } catch {
    return undefined;
  }
}

/**
 * 水位 U（双口径取大）：实测 = provider step.end usage（权威回报）；
 * 估算 = 本地 token 计数（当前 messages，含刚追加的工具结果；F1 协议感知
 * stripThinking）+ 工具定义（G3：与 pipeline budgetTokens 同口径，估算不再
 * 漏掉 tools）。缺哪路用哪路。
 */
function contextUsedTokens(
  result: StepResult | undefined,
  messages: ChatMessage[],
  tools: unknown[],
  stripThinking = true,
): number {
  // H3/F1：步后估算默认剥 thinking——openai-compatible 请求回传不含 think 块；
  // Anthropic/Responses 会回传 thinking，由 usage 实测口径兜底计入（取大不低估）。
  // 首步预检无实测可用，调用方按协议显式传入 stripThinking（见 runTurn）。
  const estimated =
    getTokenCounter().countMessages(messages, { stripThinking }) +
    getTokenCounter().countTools(tools);
  const measured =
    result?.usage === undefined ||
    !Number.isFinite(result.usage.promptTokens) ||
    !Number.isFinite(result.usage.completionTokens)
      ? undefined
      : result.usage.promptTokens + result.usage.completionTokens;
  if (measured === undefined) return estimated;
  return Math.max(estimated, measured);
}

/** 70% 提醒 system 消息（每回合至多一条，文案含已用/窗口与收敛指引） */
function makeWatermarkReminder(used: number, window: number): ChatMessage {
  const pct = Math.round((used / window) * 100);
  return {
    id: `msg_${randomUUID()}`,
    role: "system",
    content: [
      {
        type: "text",
        text:
          `${WATERMARK_REMINDER_PREFIX}约 ${pct}%（${used}/${window} tokens）。` +
          "请收敛工具调用、优先收尾；如任务未完成，先总结当前进展与下一步计划。",
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

/**
 * 交接书消息载体：结构化文本（内容=瘦身写作调用产出的三分法文本，失败降级为
 * 兜底总结；元信息=水位/棒次；足迹行=件2 机械附，无工具调用时省略）
 */
function makeHandoffBook(
  content: string,
  used: number,
  window: number,
  shift: number,
  maxShifts: number,
  footprint?: string,
): ChatMessage {
  const pct = Math.round((used / window) * 100);
  const footprintLine = footprint === undefined ? "" : `- 本棒足迹：${footprint}\n`;
  return {
    id: `msg_${randomUUID()}`,
    role: "system",
    content: [
      {
        type: "text",
        text:
          `${HANDOFF_BOOK_PREFIX} 上下文水位撞顶，本轮任务未完成，换班移交（第 ${shift}/${maxShifts} 棒）。\n` +
          `- 已用上下文：${used}/${window} tokens（${pct}%）。\n` +
          footprintLine +
          `- 内容：\n${content}`,
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

export async function runTurn(
  input: TurnInput,
  emit: (event: LLMEvent) => void
): Promise<TurnResult> {
  // 半个 turn 清洗（P1-6）：历史里 assistant 带 toolCalls 但缺 tool 结果的
  // 残缺消息（崩溃/落盘失败遗留）先修平，避免孤儿 toolCalls 污染本轮及后续
  let messages = stripUnansweredToolCalls([...input.messages]);
  let tools = input.tools;

  // ContextPipeline v2：每轮统一组装（超预算自动降级）
  let maxToolResultTokens: number | undefined;
  if (input.contextPipeline) {
    const assembled = await input.contextPipeline.pipeline.assemble({
      ...input.contextPipeline.input,
      history: messages,
      tools,
    });
    messages = assembled.messages;
    tools = assembled.tools;
    // M1：步骤内工具结果也纳入预算约束——单条上限为预算的 20%
    maxToolResultTokens = Math.max(
      1,
      Math.floor(input.contextPipeline.pipeline.budgetTokens * TOOL_RESULT_BUDGET_RATIO),
    );
  }

  const maxSteps = input.maxSteps ?? 100;
  let assistantMessage: ChatMessage | undefined;
  const toolMessages: ChatMessage[] = [];
  const appended: ChatMessage[] = [];
  let resultHandoffBook: ChatMessage | undefined;

  let step = 0;
  let watermarked = false; // 本回合已发过 70% 提醒（每回合最多一次）
  let watermarkStop = false; // 本回合已撞 90% 顶（跳出循环走兜底）
  // 最近一次水位检查的 U/W（撞顶兜底时用于交接书元信息；预检/步后都写）
  let watermarkUsed: number | undefined;
  let watermarkWindow: number | undefined;
  const handoffShift = input.handoff?.shift ?? 1;
  const handoffMaxShifts = input.handoff?.maxShifts ?? HANDOFF_DEFAULT_MAX_SHIFTS;
  // 本回合工具调用足迹（件2）：只记本回合 assistant 消息的 toolCalls，不含历史
  const turnToolCalls: Array<{ name: string; arguments?: unknown }> = [];

  // G1 首步预检：循环开始前（首步发起前）先算一次水位——messages 已含 pipeline
  // 组装结果/初始历史，tools 计入估算（G3）。撞顶则不进循环直接走水位兜底；
  // 0.7-0.9 则先注入提醒再正常进循环（与循环内检查共享"每回合一次"语义）。
  // F1（协议感知预检）：chat_completions 回传不含 think → 剥；anthropic/responses
  // 真回传 think（占窗口）→ 保留计入，避免无实测兜底的首步低估。
  // R1（型号表热更新）：预检前先让 provider 从活配置刷新协议口径（Router 实现；
  // 其它 provider 无 refresh 直接跳过），保证 PUT 改 apiMode 后本轮预检即新口径。
  await input.provider.refresh?.();
  // R2（不变量）：protocol() 单值口径绑定 Router.defaultModel——runTurn 必须以
  // defaultModel 发起；传入其它型号时预检口径可能与逐型号路由错位（think 块是否
  // 占窗口判错），warn 一次留痕，不 crash。
  if (input.provider.defaultModel !== undefined && input.model !== input.provider.defaultModel) {
    const warnKey = `${input.provider.name}\u0000${input.model}`;
    if (!routerModelMismatchWarned.has(warnKey)) {
      routerModelMismatchWarned.add(warnKey);
      logger.warn(
        {
          agentId: input.toolCtx.agentId,
          provider: input.provider.name,
          model: input.model,
          defaultModel: input.provider.defaultModel,
        },
        `[watermark] runTurn 传入型号 ${input.model} 与 provider 预检主型号 ${input.provider.defaultModel} 不一致：` +
          "protocol() 按主型号生效协议定口径，若二者协议族不同，think 计数/水位预检可能失真；" +
          "不变量：runTurn 始终以 defaultModel 发起",
      );
    }
  }
  const preUsed = contextUsedTokens(
    undefined,
    messages,
    tools,
    input.provider.protocol === "chat_completions",
  );
  const preWindow = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  watermarkUsed = preUsed;
  watermarkWindow = preWindow;
  const preRatio = preUsed / preWindow;
  // H4（日志补全）：首步预检决策留痕，真机验证可看到 used/window/ratio 与走向
  logger.info(
    {
      agentId: input.toolCtx.agentId,
      phase: "pre-check",
      used: preUsed,
      window: preWindow,
      ratio: Number(preRatio.toFixed(4)),
    },
    preRatio >= CONTEXT_STOP_RATIO
      ? "[watermark] 首步预检撞顶：不进循环，直接走水位兜底"
      : preRatio >= CONTEXT_WARN_RATIO
        ? "[watermark] 首步预检提醒：注入 70% 提醒后进循环"
        : "[watermark] 首步预检通过：正常进循环",
  );
  if (preRatio >= CONTEXT_STOP_RATIO) {
    watermarkStop = true;
  } else if (preRatio >= CONTEXT_WARN_RATIO && !watermarked) {
    const reminder = makeWatermarkReminder(preUsed, preWindow);
    messages.push(reminder);
    appended.push(reminder);
    if (input.onStepAppended) {
      await input.onStepAppended([reminder]);
    }
    watermarked = true;
  }

  for (; step < maxSteps && !watermarkStop; step++) {
    if (input.signal?.aborted) {
      throw new Error("aborted");
    }
    const stepInput: StepInput = {
      provider: input.provider,
      model: input.model,
      messages,
      tools,
      toolCtx: input.toolCtx,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      topP: input.topP,
      maxToolResultTokens,
      onLLMRequest: input.onLLMRequest,
    };

    let result: StepResult;
    try {
      result = await executeLoopStep(stepInput, emit);
    } catch (err) {
      // P3-3：流式中断的半截 assistant 消息随 StepStreamError 上来——
      // 先按 step 级落盘（与用户所见一致），再继续上抛
      // （worker catch 补错误文本与 turn.end 终帧，P3-1）
      if (err instanceof StepStreamError && err.partialMessage) {
        messages.push(err.partialMessage);
        appended.push(err.partialMessage);
        if (input.onStepAppended) {
          await input.onStepAppended([err.partialMessage]);
        }
      }
      throw err;
    }
    assistantMessage = result.assistantMessage;
    if (result.assistantMessage.toolCalls) {
      turnToolCalls.push(
        ...result.assistantMessage.toolCalls.map((tc) => ({
          name: tc.name,
          arguments: tc.arguments,
        })),
      );
    }
    // P1-2 落盘前 guard：空 content 的 assistant 消息（provider 只发 step.end
    // 等异常形状）不落盘不入历史——否则下一轮回传会产生 400/污染上下文。
    if (hasAssistantContent(result.assistantMessage)) {
      messages.push(result.assistantMessage);
      appended.push(result.assistantMessage);

      const stepMessages: ChatMessage[] = [result.assistantMessage];
      if (result.toolMessages) {
        messages.push(...result.toolMessages);
        toolMessages.push(...result.toolMessages);
        appended.push(...result.toolMessages);
        stepMessages.push(...result.toolMessages);
      }

      // step 级落盘（P1-6）：assistant 与其 tool 结果同批回调，崩溃只丢当前
      // 执行中的 step；落盘失败中止本轮，热存储不留缺 tool 结果的半截 step
      if (input.onStepAppended) {
        await input.onStepAppended(stepMessages);
      }
    }

    // 水位判据（改动一）：每步结束后（工具结果已追加、下一步发起前）算 r = U / W。
    // 只作用于还会继续的 tool_use 步：撞顶即收（走兜底绝不静默），提醒则继续。
    if (result.stopReason === "tool_use") {
      const used = contextUsedTokens(result, messages, tools);
      const window = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      watermarkUsed = used;
      watermarkWindow = window;
      const ratio = used / window;
      if (ratio >= CONTEXT_STOP_RATIO) {
        logger.info(
          {
            agentId: input.toolCtx.agentId,
            phase: "step",
            step,
            used,
            window,
            ratio: Number(ratio.toFixed(4)),
          },
          "[watermark] 步后撞顶：跳出循环走水位兜底",
        );
        watermarkStop = true;
        break;
      }
      if (ratio >= CONTEXT_WARN_RATIO) {
        if (!watermarked) {
          logger.info(
            {
              agentId: input.toolCtx.agentId,
              phase: "step",
              step,
              used,
              window,
              ratio: Number(ratio.toFixed(4)),
            },
            "[watermark] 步后提醒：注入 70% 提醒后继续",
          );
          const reminder = makeWatermarkReminder(used, window);
          messages.push(reminder);
          appended.push(reminder);
          if (input.onStepAppended) {
            await input.onStepAppended([reminder]);
          }
          watermarked = true;
        } else {
          logger.debug(
            {
              agentId: input.toolCtx.agentId,
              phase: "step",
              step,
              used,
              window,
              ratio: Number(ratio.toFixed(4)),
            },
            "[watermark] 步后已达提醒带但本回合已提醒过（每回合一次）",
          );
        }
      } else {
        logger.debug(
          {
            agentId: input.toolCtx.agentId,
            phase: "step",
            step,
            used,
            window,
            ratio: Number(ratio.toFixed(4)),
          },
          "[watermark] 步后未达提醒带，继续循环",
        );
      }
    }

    if (result.stopReason !== "tool_use") {
      break;
    }
  }

  // 撞顶兜底（真机实锤）：保险丝（循环耗尽）或水位撞顶且最后一次仍是工具调用——
  // 直接退出会让回合静默结束（无 assistant 回复）。追加一次无工具总结调用，绝不静默。
  if (step >= maxSteps || watermarkStop) {
    // H4（日志补全）：兜底决策留痕，区分水位撞顶与保险丝耗尽
    logger.info(
      {
        agentId: input.toolCtx.agentId,
        phase: "fallback",
        reason: watermarkStop ? "watermark" : "max_steps",
        step,
        maxSteps,
      },
      watermarkStop
        ? "[watermark] 水位撞顶兜底：追加无工具总结"
        : "[watermark] 保险丝耗尽兜底：追加无工具总结",
    );
    const summary = await runMaxStepsSummary(
      input,
      messages,
      maxToolResultTokens,
      emit,
      watermarkStop ? "watermark" : "max_steps",
    );
    messages.push(summary);
    appended.push(summary);
    assistantMessage = summary;
    if (input.onStepAppended) {
      await input.onStepAppended([summary]);
    }
    // 水位撞顶 = 换班移交：交接书作为消息载体落历史（onStepAppended 持久化），
    // 供续跑置顶注入与用户回溯。不进 appended（system 载体，话题 tracker 与
    // 向量索引都不需要；现有"appended 末尾=兜底产出"断言语义保持不破）。
    if (watermarkStop) {
      const used = watermarkUsed ?? contextUsedTokens(undefined, messages, tools);
      const window = watermarkWindow ?? input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const footprint = formatHandoffFootprint(turnToolCalls);
      const summaryText = assistantText(summary);
      // 瘦身写作间（件3）：独立小调用写三分法内容；失败/空文本降级为兜底总结
      const written = await writeHandoffBookContent(input, summaryText, footprint);
      const book = makeHandoffBook(
        written ?? truncateHandoffText(summaryText, HANDOFF_WRITTEN_MAX),
        used,
        window,
        handoffShift,
        handoffMaxShifts,
        footprint,
      );
      messages.push(book);
      if (input.onStepAppended) {
        await input.onStepAppended([book]);
      }
      resultHandoffBook = book;
    }
  }

  // turn 级结束帧：与 step.end（每个 loop step 都发）区分，
  // 前端只在收到本帧时才复位"生成中"状态，避免工具执行期间输入框提前解锁
  emit({ type: "turn.end" });

  return {
    messages,
    assistantMessage: assistantMessage!,
    toolMessages,
    appended,
    watermarkStopped: watermarkStop,
    ...(resultHandoffBook !== undefined
      ? {
          handoffBook: resultHandoffBook,
          handoffShift,
          handoffMaxShifts,
          watermarkUsed: watermarkUsed ?? 0,
          watermarkWindow: watermarkWindow ?? 0,
        }
      : {}),
  };
}

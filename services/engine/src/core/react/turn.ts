import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMEvent, LLMChatParams } from "../../provider/types.js";
import { executeLoopStep, StepStreamError, type StepInput, type StepResult } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  type AssembleInput,
  type ContextPipeline,
} from "../../context/pipeline.js";
import {
  DEFAULT_MAX_TOOL_RESULT_TOKENS,
  TOOL_RESULT_BUDGET_RATIO,
  truncateToolResultText,
} from "../../context/truncate.js";
import { getTokenCounter } from "../../context/token-counter.js";
import { stripUnansweredToolCalls } from "../../context/history-sanitize.js";
import { logger } from "../../logger.js";
import { HANDOFF_DEFAULT_MAX_SHIFTS } from "../../handoff/types.js";
import {
  CONTEXT_STOP_RATIO,
  CONTEXT_WARN_RATIO,
  contextUsedTokens,
  makeWatermarkReminder,
} from "./watermark.js";
import { runMaxStepsSummary, type SummaryReason } from "./summary.js";
import {
  formatHandoffFootprint,
  HANDOFF_WRITTEN_MAX,
  makeHandoffBook,
  truncateHandoffText,
  writeHandoffBookContent,
} from "./handoff-book.js";
import { assistantText } from "./shared.js";

// D5 拆分：水位判定 / 兜底总结 / 交接书写作已切块至 watermark / summary /
// handoff-book 子模块；以下导出物原位置 re-export，turn.ts 对外 API 不变
//（消费方零改动）。
export {
  MAX_STEPS_SUMMARY_HINT,
  CONTEXT_WATERMARK_SUMMARY_HINT,
  MAX_STEPS_FALLBACK_REPLY,
  CONTEXT_WATERMARK_FALLBACK_REPLY,
  EMPTY_STOP_SUMMARY_HINT,
} from "./summary.js";
export { HANDOFF_BOOK_PREFIX, HANDOFF_WRITING_GUIDANCE } from "./handoff-book.js";

/**
 * M4：单步工具结果合计占上下文预算的上限——单条 20%（TOOL_RESULT_BUDGET_RATIO）
 * 之外加总量阀，防一步多工具叠加注入击穿窗口（5 条 × 20% = 100%）。
 */
const TOOL_STEP_TOTAL_BUDGET_RATIO = 0.4;
/** M4：合计预算耗尽时末位工具结果的占位文本（绝不静默吞掉整条结果） */
export const TOOL_STEP_OVERFLOW_PLACEHOLDER = "[工具结果超出单步合计预算，已省略]";

/** R2（B 方案不变量）：runTurn 型号 ≠ provider.defaultModel 的 warn 去重（每 provider+型号一次） */
const routerModelMismatchWarned = new Set<string>();

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

/** assistant 消息是否有可落盘内容（文本/思考/工具调用任一非空）——P1-2 空 content 不落盘 */
function hasAssistantContent(message: ChatMessage): boolean {
  if ((message.toolCalls?.length ?? 0) > 0) return true;
  return message.content.some((c) =>
    (c.type === "text" && Boolean(c.text)) || (c.type === "think" && Boolean(c.think)),
  );
}

/**
 * M4：单步工具结果合计上限的二次截断——按序消耗合计预算，超额结果沿用
 * 单条截断策略（truncateToolResultText：保头尾 + 省略标记）截到剩余预算；
 * 预算耗尽的末位结果留占位文本，绝不静默吞掉整条（模型需感知该结果存在过）。
 */
function enforceStepToolResultTotal(toolMessages: ChatMessage[], totalBudget: number): void {
  const counter = getTokenCounter();
  let used = 0;
  for (const message of toolMessages) {
    const part = message.content[0];
    if (!part || part.type !== "text") continue;
    const remaining = totalBudget - used;
    const tokens = counter.countText(part.text);
    if (tokens <= remaining) {
      used += tokens;
      continue;
    }
    const truncated = truncateToolResultText(part.text, Math.max(remaining, 0), counter);
    part.text = truncated === "" ? TOOL_STEP_OVERFLOW_PLACEHOLDER : truncated;
    used += counter.countText(part.text);
  }
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
  let maxToolStepTotalTokens: number | undefined;
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
    // M4：同预算的单步合计上限（40%）——单条 20% × 多工具可叠加至 100%，总量阀兜底
    maxToolStepTotalTokens = Math.max(
      1,
      Math.floor(input.contextPipeline.pipeline.budgetTokens * TOOL_STEP_TOTAL_BUDGET_RATIO),
    );
  }
  // M4 生效口径：无 pipeline 时按单条缺省上限（≈预算 20%，16000）同比例放大 = 32000
  const stepToolTotalCap = maxToolStepTotalTokens ?? 2 * DEFAULT_MAX_TOOL_RESULT_TOKENS;

  const maxSteps = input.maxSteps ?? 100;
  let assistantMessage: ChatMessage | undefined;
  const toolMessages: ChatMessage[] = [];
  const appended: ChatMessage[] = [];
  let resultHandoffBook: ChatMessage | undefined;

  let step = 0;
  let watermarked = false; // 本回合已发过 70% 提醒（每回合最多一次）
  let watermarkStop = false; // 本回合已撞 90% 顶（跳出循环走兜底）
  let emptyStop = false; // 本回合以空内容 stop 收尾（M5：视同异常收尾走兜底，绝不静默）
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
        // M4：单步多工具合计阀——合计超 40% 预算的部分逐条二次截断（保头尾）
        enforceStepToolResultTotal(result.toolMessages, stepToolTotalCap);
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
    // tool_use 步：撞顶即收（走兜底绝不静默），提醒则继续；
    // 非工具收尾步（M1）：break 前也判一次撞顶，超窗按既有撞顶路径产交接书。
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
      // M1（水位判定盲区）：非工具收尾步（长文本/max_tokens 等）break 前也过一次
      // 撞顶判定——超窗视同水位撞顶，按既有撞顶路径走兜底产交接书；
      // 提醒带不处理（回合本就要结束，提醒无意义）。
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
          "[watermark] 非工具收尾步撞顶：跳出循环走水位兜底",
        );
        watermarkStop = true;
      }
      // M5：空内容 stop 视同异常收尾——走兜底回复路径（无工具总结/兜底文案），绝不静默
      if (!hasAssistantContent(result.assistantMessage)) {
        emptyStop = true;
      }
      break;
    }
  }

  // 撞顶兜底（真机实锤）：保险丝（循环耗尽）或水位撞顶且最后一次仍是工具调用——
  // 直接退出会让回合静默结束（无 assistant 回复）。追加一次无工具总结调用，绝不静默。
  // M5：空内容 stop 收尾视同异常收尾，同走此兜底（与撞顶兜底同哲学）。
  if (step >= maxSteps || watermarkStop || emptyStop) {
    const summaryReason: SummaryReason = watermarkStop
      ? "watermark"
      : emptyStop
        ? "empty_stop"
        : "max_steps";
    // H4（日志补全）：兜底决策留痕，区分水位撞顶/保险丝耗尽/空内容收尾
    logger.info(
      {
        agentId: input.toolCtx.agentId,
        phase: "fallback",
        reason: summaryReason,
        step,
        maxSteps,
      },
      watermarkStop
        ? "[watermark] 水位撞顶兜底：追加无工具总结"
        : emptyStop
          ? "[react] 空内容收尾兜底（M5）：追加无工具总结"
          : "[watermark] 保险丝耗尽兜底：追加无工具总结",
    );
    const summary = await runMaxStepsSummary(
      input,
      messages,
      maxToolResultTokens,
      emit,
      summaryReason,
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

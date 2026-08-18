import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider, LLMChatParams } from "../../provider/types.js";
import { randomUUID } from "node:crypto";
import { executeLoopStep } from "./step.js";
import type { ToolExecutionContext } from "./tool-call.js";
import { assistantText, isAbortError } from "./shared.js";

/** 交接书消息载体前缀（水位撞顶=换班移交：换班不死）。
 *  单一来源（D5 拆分后）：context/pipeline.ts 的 L3 历史过滤直接 import 本模块——
 *  本模块不得 import pipeline/context 任何东西，否则 context 反向 import core 成环 */
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
export const HANDOFF_WRITTEN_MAX = 3000;

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
export function formatHandoffFootprint(
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
export function truncateHandoffText(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - HANDOFF_TRUNCATE_PREFIX.length;
  if (keep <= 0) return HANDOFF_TRUNCATE_PREFIX.slice(0, max);
  return HANDOFF_TRUNCATE_PREFIX + text.slice(-keep);
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
 * 瘦身写作入参（D5 拆分：TurnInput 子集，结构兼容——调用方原样传 TurnInput；
 * 参数化显式传入，不反向 import turn.ts，防循环依赖）。
 */
export interface HandoffWriteInput {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  toolCtx: ToolExecutionContext;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  onLLMRequest?: (params: LLMChatParams) => Promise<void>;
  handoff?: { shift: number; maxShifts: number; bookText?: string };
  resolveSessionTaskText?: () => Promise<string | undefined>;
}

/**
 * 瘦身写作间（件3）：独立小调用写交接书三分法内容，与全量兜底回复调用分离。
 * system = 写作指引；user = 材料包四样（任务原消息/上一棒交接书/本棒足迹/本棒回顾）。
 * K1：任务原消息优先 repository 解析（session 首条用户消息），查不到退回窗口内首条；
 * 上一棒交接书优先 handoff.bookText（控制面权威），窗口扫描仅作兜底。
 * K3：上一棒交接书截 3000、本棒回顾素材截 2000、写作产出截 3000（省略号标注）。
 * 单步（maxSteps=1 语义）、无工具；内部调用不向用户流式转发（no-op emit）。
 * 失败/空文本/违规工具调用 → undefined（调用方降级为兜底总结文本直接装入）；
 * abort 除外——取消即中止，原样上抛（M3），换班链不再推进。
 */
export async function writeHandoffBookContent(
  input: HandoffWriteInput,
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
  } catch (err) {
    // M3：abort 不吞——取消即中止（原样上抛）；其他错误维持降级语义
    if (isAbortError(err, input.signal)) throw err;
    return undefined;
  }
}

/**
 * 交接书消息载体：结构化文本（内容=瘦身写作调用产出的三分法文本，失败降级为
 * 兜底总结；元信息=水位/棒次；足迹行=件2 机械附，无工具调用时省略）
 */
export function makeHandoffBook(
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

import type { ChatMessage } from "@cloudmind/shared";
import { randomUUID } from "node:crypto";
import type { StepResult } from "./step.js";
import { getTokenCounter } from "../../context/token-counter.js";
import { WATERMARK_REMINDER_PREFIX } from "../../context/pipeline.js";

/**
 * 上下文水位主裁（改动一）：硬编码产品语义，不开放配置。
 * 0.7 = 提醒线：每回合至多追加一条 system 提醒后继续；0.9 = 撞顶线：跳出循环走兜底。
 */
export const CONTEXT_WARN_RATIO = 0.7;
export const CONTEXT_STOP_RATIO = 0.9;

/**
 * 水位 U（双口径取大）：实测 = provider step.end usage（权威回报）；
 * 估算 = 本地 token 计数（当前 messages，含刚追加的工具结果；F1 协议感知
 * stripThinking）+ 工具定义（G3：与 pipeline budgetTokens 同口径，估算不再
 * 漏掉 tools）。缺哪路用哪路。
 */
export function contextUsedTokens(
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
export function makeWatermarkReminder(used: number, window: number): ChatMessage {
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

import type { ChatMessage } from "@mindcloud/shared";

/**
 * react 循环子模块共享纯函数（叶模块：不 import 任何 engine 模块，
 * turn / summary / handoff-book 共用——放各自模块会互相反向 import 成环）。
 */

export function assistantText(message: ChatMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * M3：abort 判定——signal 已中止 / AbortError / step 层抛出的 "aborted" 错误
 * （流式循环内的 abort 会被 StepStreamError 包裹，原始错误挂在 cause 上）。
 */
export function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (err instanceof Error && (err.name === "AbortError" || err.message === "aborted")) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return cause instanceof Error && cause.message === "aborted";
}

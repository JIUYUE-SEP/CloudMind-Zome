import OpenAI from "openai";
import { ProviderError } from "./errors.js";

/** 可重试的 Node 网络错误码（连接被重置/超时/拒绝等瞬态故障） */
const RETRYABLE_ERRNO_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
]);

/**
 * LLM 调用错误分类（fail-closed）：
 * - 可重试：429（限流）、5xx（服务端故障）、网络错误、超时
 * - 不可重试：401/403/400 及其他 4xx（请求或配置本身有问题，重试无意义）
 * - 无法归类的错误一律不可重试
 */
export function isRetryableError(err: unknown): boolean {
  // ProviderError 携带抛出方的分类结论
  if (err instanceof ProviderError) return err.retryable;

  // 网络错误 / 超时（OpenAI SDK 专用类，无 status）
  if (err instanceof OpenAI.APIConnectionError) return true;

  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429) return true;
    if (typeof status === "number" && status >= 500) return true;
    return false;
  }

  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && RETRYABLE_ERRNO_CODES.has(code)) return true;

  return false;
}

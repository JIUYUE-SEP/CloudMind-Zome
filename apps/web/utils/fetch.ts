const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 统一带超时的 fetch：默认 10 秒未响应即中止。
 * 超时时抛出带明确中文提示的 Error，由调用方（store/composable）的错误路径上屏。
 */
export async function fetchWithTimeout(
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error("请求超时，请检查 engine 是否运行");
    }
    throw err;
  }
}

/**
 * Provider 协议族共享基建（仿 opencode packages/llm/src/protocols/shared.ts
 * 的职责划分，但按 CMZ 基建实现：无 effect/sst 依赖，直接用 Node fetch +
 * 手写 SSE 解析）。
 *
 * opencode 的 shared.ts 承担三类职责，这里一一对应：
 * - 流式工具调用累加器（ToolAccumulator / parseToolInput）→ toolStream 状态机；
 * - SSE 帧解析（sseFraming）→ readSseData（浏览器/Node 通用 ReadableStream）；
 * - 公共错误构造（invalidRequest / eventError）→ toProviderError / retryable 分类。
 */
import { logger } from "../../logger.js";
import { ProviderError } from "../errors.js";

/** baseUrl 尾部斜杠归一（现有 compute 路由同口径） */
export function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Anthropic Messages 端点路径归一：
 * - https://api.deepseek.com             → /anthropic/v1/messages
 * - https://api.deepseek.com/anthropic   → /v1/messages
 * - https://api.deepseek.com/anthropic/v1 → /messages
 * （DeepSeek 官方 Anthropic 兼容 base_url 是 https://api.deepseek.com/anthropic，
 *   部分网关也接受根域 + /anthropic/v1/messages 两种写法，这里全部兜住。）
 */
export function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = trimBaseUrl(baseUrl);
  if (trimmed.endsWith("/anthropic/v1")) return `${trimmed}/messages`;
  if (trimmed.endsWith("/anthropic")) return `${trimmed}/v1/messages`;
  return `${trimmed}/anthropic/v1/messages`;
}

/** 非 2xx 状态是否可重试（与 resilient/classify 同口径：429/5xx 可重试） */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** 网络层错误（fetch 抛错 / 超时 / 非 2xx）统一包装为 ProviderError */
export function toProviderError(
  provider: string,
  cause: unknown,
  options?: { retryable?: boolean; status?: number },
): ProviderError {
  const retryable =
    options?.retryable ??
    (options?.status !== undefined ? isRetryableStatus(options.status) : isNetworkError(cause));
  return new ProviderError(provider, cause, { retryable });
}

function isNetworkError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") {
    return new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"]).has(code);
  }
  if (cause instanceof Error && cause.name === "AbortError") return true;
  return false;
}

export interface PostJsonOptions {
  apiKey?: string;
  requestTimeout?: number;
  /** 自定义头（如 Anthropic 的 x-api-key / anthropic-version） */
  headers?: Record<string, string>;
  /** 是否用 x-api-key 头（Anthropic 系）；缺省用 Authorization: Bearer */
  apiKeyHeader?: "bearer" | "x-api-key";
}

/**
 * JSON POST + SSE 响应读取。返回 (status, headers, sseData)：
 * - 非 2xx 抛 ProviderError（retryable 按状态分类）；
 * - 2xx 且 body 为 null / 非流式响应抛 ProviderError（不可重试，协议违约）。
 */
export async function postJsonStream(
  provider: string,
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<{ status: number; headers: Headers; data: AsyncGenerator<string> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };
  if (options.apiKey) {
    if (options.apiKeyHeader === "x-api-key") headers["x-api-key"] = options.apiKey;
    else headers.authorization = `Bearer ${options.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options.requestTimeout !== undefined
        ? { signal: AbortSignal.timeout(options.requestTimeout) }
        : {}),
    });
  } catch (err) {
    throw toProviderError(provider, err);
  }

  if (!response.ok) {
    // 尽量读错误正文辅助排障（读失败不覆盖原始错误）
    let detail = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) detail = `${detail}: ${text.slice(0, 500)}`;
    } catch {
      // 忽略错误正文读取失败
    }
    throw toProviderError(provider, detail, { status: response.status });
  }

  if (!response.body) {
    throw toProviderError(provider, "SSE response has no body");
  }
  return {
    status: response.status,
    headers: response.headers,
    data: readSseData(response.body),
  };
}

/**
 * SSE data 帧解析（手写，零依赖）：
 * - 逐 chunk 按 \n 切行，兼容 \r\n；
 * - `data:` 行累积（多行 data 按规范以 \n 拼接），空行触发一次 dispatch；
 * - `:` 注释行、`event:`/`id:`/`retry:` 忽略（本协议族只消费 data）；
 * - `[DONE]`（chat completions 终结帧）不产出；
 * - 流结束仍有未 dispatch 的 data 行（无尾空行）也产出，容错各家网关。
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    if (data.length > 0) {
      // 延迟到 await 边界外产出——生成器内同步抛错会被 for-await 正常捕获
      pending.push(data);
    }
  };
  const pending: string[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          dispatch();
          while (pending.length > 0) yield pending.shift() as string;
          continue;
        }
        if (line.startsWith(":")) continue; // SSE 注释
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        // event:/id:/retry: 本协议族不需要
      }
    }
    if (buffer) {
      const line = buffer.replace(/\r$/, "");
      if (line === "") dispatch();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    dispatch();
    while (pending.length > 0) yield pending.shift() as string;
  } finally {
    reader.releaseLock();
  }
}

export interface PendingTool {
  id: string;
  name: string;
  /** 累积的原始 JSON 参数字符串（尚未 parse） */
  args: string;
}

/** 解析流式工具参数；空串按 "{}" 处理（零参数工具），解析失败 warn + 回退 {} */
export function parseToolArgs(name: string, raw: string): unknown {
  const text = raw || "{}";
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.warn(
      { err: err, toolName: name, raw: text },
      `[provider] 工具参数 JSON 解析失败，按空对象降级`,
    );
    return {};
  }
}

/** 普通对象判定（用户/助手消息内容里 think 与 text 统一处理用） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

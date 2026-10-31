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
import OpenAI from "openai";

/** baseUrl 尾部斜杠归一（现有 compute 路由同口径） */
export function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Anthropic Messages 协议版本头（原生 Anthropic 与 DeepSeek 兼容端点同一取值） */
export const ANTHROPIC_VERSION = "2023-06-01";

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

/**
 * Anthropic models 列表端点路径归一（与 anthropicMessagesUrl 同口径）：
 * - https://api.deepseek.com             → /anthropic/v1/models
 * - https://api.deepseek.com/anthropic   → /v1/models
 * - https://api.deepseek.com/anthropic/v1 → /models
 */
export function anthropicModelsUrl(baseUrl: string): string {
  const trimmed = trimBaseUrl(baseUrl);
  if (trimmed.endsWith("/anthropic/v1")) return `${trimmed}/models`;
  if (trimmed.endsWith("/anthropic")) return `${trimmed}/v1/models`;
  return `${trimmed}/anthropic/v1/models`;
}

/** 非 2xx 状态是否可重试（与 resilient 同口径：429/5xx 可重试） */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** 可重试的 Node 网络错误码（A7 合一后本文件即权威实现） */
const RETRYABLE_ERRNO_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
]);
/** undici（Node fetch 底层）错误码前缀：UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT 等 */
const UND_ERR_PREFIX = "UND_ERR_";
/** cause 链最大遍历深度（防畸形错误对象成环拖死分类） */
const MAX_CAUSE_DEPTH = 6;

function isRetryableCode(code: unknown): boolean {
  return (
    typeof code === "string" &&
    (RETRYABLE_ERRNO_CODES.has(code) || code.startsWith(UND_ERR_PREFIX))
  );
}

/**
 * 网络层错误判定，沿 cause 链逐层检查（review P1 修复）：
 * - Node fetch 把网络错误包装成 `TypeError: fetch failed`，真实码在
 *   `err.cause.code`（ECONNREFUSED / ECONNRESET / UND_ERR_* 等）；
 * - AbortSignal.timeout 的拒绝值是 TimeoutError（不是 AbortError），同样可重试；
 * - undici 偶发抛 AggregateError，errors 数组逐个递归。
 */
function isNetworkError(cause: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || cause === undefined || cause === null) return false;
  if (cause instanceof AggregateError && Array.isArray(cause.errors)) {
    if (cause.errors.some((e) => isNetworkError(e, depth + 1))) return true;
  }
  if (cause instanceof Error) {
    if (cause.name === "AbortError" || cause.name === "TimeoutError") return true;
    if (isRetryableCode((cause as NodeJS.ErrnoException).code)) return true;
  }
  const nested =
    typeof cause === "object" && "cause" in cause
      ? (cause as { cause?: unknown }).cause
      : undefined;
  return nested === cause ? false : isNetworkError(nested, depth + 1);
}

/**
 * LLM 调用错误分类（A7 重试分类合一：原 provider/classify.ts 并入本文件，
 * 保留能力更强的那份——cause 链递归 / UND_ERR_ 前缀 / AggregateError，并兼容
 * OpenAI SDK 错误类）：
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

  // 其余（Node fetch 网络错误/超时/undici 错误等）沿 cause 链分类
  return isNetworkError(err);
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

export interface PostJsonOptions {
  apiKey?: string;
  requestTimeout?: number;
  /** 自定义头（如 Anthropic 的 x-api-key / anthropic-version） */
  headers?: Record<string, string>;
  /** 是否用 x-api-key 头（Anthropic 系）；缺省用 Authorization: Bearer */
  apiKeyHeader?: "bearer" | "x-api-key";
}

/**
 * 流空闲超时缺省值（ms）：未配置 `requestTimeout` 时生效。
 *
 * 取 180s 而非更短：reasoning 模型首 token 前常有长时间静默（思考阶段），
 * 阈值太短会误杀正常推理。180s 无任何数据已远超正常生成间隔，只可能是
 * 链路挂死。
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

/**
 * 空闲超时错误：**独立 name**，不得复用 `TimeoutError`。
 *
 * `isNetworkError` 把 `AbortError` / `TimeoutError` 归为可重试网络错误；
 * 而流空闲超时发生时可能已产出部分内容，重试会导致重复输出，必须判不可重试。
 * 用独立 name 让它走「无法归类 → 不可重试」分支（见 isRetryableError 注释）。
 */
export class StreamIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`流空闲超时：${idleTimeoutMs}ms 内未收到任何数据`);
    this.name = "StreamIdleTimeoutError";
  }
}

/**
 * 空闲超时取值：
 * - 显式配置的 `requestTimeout` 优先（≤0 或非有限值视为关闭）；
 * - 未配置时读环境变量 `CLOUDMIND_STREAM_IDLE_TIMEOUT_MS`（"0" 关闭）；
 * - 都没有则用 {@link DEFAULT_STREAM_IDLE_TIMEOUT_MS}。
 *
 * 未配置即完全无超时是缺陷而非特性（responses/anthropic 原实现只在
 * `requestTimeout !== undefined` 时挂 signal），故缺省必须有值。
 */
export function resolveIdleTimeoutMs(configured?: number): number | undefined {
  if (configured !== undefined) {
    return Number.isFinite(configured) && configured > 0 ? configured : undefined;
  }
  const raw = process.env.CLOUDMIND_STREAM_IDLE_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    if (parsed === 0) return undefined; // 显式关闭
    logger.warn(
      { raw },
      "[provider] CLOUDMIND_STREAM_IDLE_TIMEOUT_MS 取值非法，回落缺省空闲超时",
    );
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/** 空闲超时看护句柄（三个协议适配器共用；未启用时 signal 为 undefined，其余方法空转） */
export interface IdleTimeout {
  readonly signal: AbortSignal | undefined;
  /** 每收到一个数据块调用一次，重置计时 */
  reset: () => void;
  /** 停止计时并清理定时器（流结束/出错后必须调用，防定时器泄漏） */
  dispose: () => void;
  /** 是否已因空闲超时触发 abort */
  readonly timedOut: boolean;
  /** 把底层错误映射为对外错误：超时 → StreamIdleTimeoutError，其余原样透传 */
  mapError: (err: unknown) => unknown;
}

/**
 * 创建空闲超时看护。
 *
 * **语义是「多久没数据」，不是「总共花了多久」**——流式长回答与 reasoning
 * 长思考天然会超过任何固定总时长，用总时长会在正常任务上误杀。计时器在每次
 * `reset()` 时重置，只有连续静默才触发。
 *
 * 定时器一律 `unref()`：看护不应阻止进程正常退出。
 */
export function createIdleTimeout(configuredMs?: number): IdleTimeout {
  const ms = resolveIdleTimeoutMs(configuredMs);
  if (ms === undefined) {
    return {
      signal: undefined,
      reset: () => {},
      dispose: () => {},
      timedOut: false,
      mapError: (err) => err,
    };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new StreamIdleTimeoutError(ms));
    }, ms);
    // 别让看护定时器吊住进程退出
    if (typeof timer.unref === "function") timer.unref();
  };

  arm();

  return {
    signal: controller.signal,
    reset: arm,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    get timedOut() {
      return timedOut;
    },
    mapError: (err) => (timedOut ? new StreamIdleTimeoutError(ms) : err),
  };
}

/**
 * JSON POST + SSE 响应读取。返回 (status, headers, sseData)：
 * - 非 2xx 抛 ProviderError（retryable 按状态分类）；
 * - 2xx 且 body 为 null / 非流式响应抛 ProviderError（不可重试，协议违约）。
 *
 * 超时语义（2026-11-01 P1）：`requestTimeout` 表示**流空闲超时**——发出请求后
 * 开始计时、每收到一个 SSE 数据块重置，连续静默超过阈值才中断。此前用
 * `AbortSignal.timeout` 作总时长，会在长回答上误杀；且未配置时根本不挂 signal
 * （responses/anthropic 挂死即永久阻塞）。现统一为：有配置用配置值，无配置用
 * 缺省 180s，`0` 显式关闭。
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

  const idle = createIdleTimeout(options.requestTimeout);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(idle.signal !== undefined ? { signal: idle.signal } : {}),
    });
  } catch (err) {
    idle.dispose();
    throw toProviderError(
      provider,
      idle.mapError(err),
      idle.timedOut ? { retryable: false } : undefined,
    );
  }

  if (!response.ok) {
    idle.dispose();
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
    idle.dispose();
    throw toProviderError(provider, "SSE response has no body");
  }
  return {
    status: response.status,
    headers: response.headers,
    data: readSseData(response.body, idle),
  };
}

/**
 * SSE data 帧解析（手写，零依赖）：
 * - 逐 chunk 按 \n 切行，兼容 \r\n；
 * - `data:` 行累积（多行 data 按规范以 \n 拼接），空行触发一次 dispatch；
 * - `:` 注释行、`event:`/`id:`/`retry:` 忽略（本协议族只消费 data）；
 * - `[DONE]`（chat completions 终结帧）不产出；
 * - 流结束仍有未 dispatch 的 data 行（无尾空行）也产出，容错各家网关。
 *
 * `idle` 为空闲超时看护：每次读到数据重置计时，读取抛错时把超时错误映射成
 * {@link StreamIdleTimeoutError}（reader.read 在 abort 时抛的多是 AbortError，
 * 不能直接上抛——那会被判成可重试网络错误）。
 */
async function* readSseData(
  body: ReadableStream<Uint8Array>,
  idle?: IdleTimeout,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];
  // P2-1（review）：流是否已完整消费；提前 return / 中途断开 / 超时时
  // 在 finally 里主动 cancel 底层响应体，释放未读完的连接
  let fullyConsumed = false;

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
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (err) {
        // abort 触发的拒绝可能是 AbortError（可重试类目），必须换成本意
        throw idle ? idle.mapError(err) : err;
      }
      idle?.reset();
      const { done, value } = read;
      if (done) {
        fullyConsumed = true;
        break;
      }
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
    idle?.dispose();
    if (!fullyConsumed) {
      // 流可能已 error（网络断开/超时）：cancel 失败不覆盖原始错误
      try {
        await reader.cancel();
      } catch {
        // 连接已由 abort/网络层释放，无需再处理
      }
    }
    reader.releaseLock();
  }
}

export interface PendingTool {
  id: string;
  name: string;
  /** 累积的原始 JSON 参数字符串（尚未 parse） */
  args: string;
}

/** 日志/错误里的原始文本截断（A2 隐私收敛）：超 500 字符截断并标注，防超长 raw 泄入日志 */
export function truncateLogText(value: string, max = 500): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…（已截断 ${value.length - max} 字符）`;
}

/** 解析流式工具参数；空串按 "{}" 处理（零参数工具），解析失败 warn + 回退 {} */
export function parseToolArgs(name: string, raw: string): unknown {
  const text = raw || "{}";
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.warn(
      { err: err, toolName: name, raw: truncateLogText(text) },
      `[provider] 工具参数 JSON 解析失败，按空对象降级`,
    );
    return {};
  }
}

/** 普通对象判定（用户/助手消息内容里 think 与 text 统一处理用） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const TAVILY_API_URL = "https://api.tavily.com/search";
const TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const CONTENT_MAX_CHARS = 500;
const TOTAL_OUTPUT_BUDGET = 4000;

const parameters = z.object({
  query: z.string().min(1).describe("搜索关键词"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS_LIMIT)
    .default(DEFAULT_MAX_RESULTS)
    .describe(`返回结果条数（默认 ${DEFAULT_MAX_RESULTS}，上限 ${MAX_RESULTS_LIMIT}）`),
});

interface SearchResultItem {
  title: string;
  url: string;
  content: string;
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Tavily results → 紧凑列表（content 截断 ~500 字符） */
function mapResults(payload: unknown): SearchResultItem[] {
  const raw = payload as { results?: unknown[] };
  if (!Array.isArray(raw.results)) return [];
  const items: SearchResultItem[] = [];
  for (const entry of raw.results) {
    // null/非对象条目（防御）：跳过而不是在 record.title 上抛 TypeError
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : "";
    const url = typeof record.url === "string" ? record.url : "";
    const content = truncateText(
      typeof record.content === "string" ? record.content : "",
      CONTENT_MAX_CHARS,
    );
    if (title || url || content) items.push({ title, url, content });
  }
  return items;
}

/**
 * 总输出预算（~4000 字符）：整页/超长正文不能塞进模型上下文——
 * 超预算时从尾部丢弃结果（至少保留一条）。
 */
function fitTotalBudget(items: SearchResultItem[]): SearchResultItem[] {
  const result = [...items];
  const totalLength = () =>
    result.reduce((n, item) => n + item.title.length + item.url.length + item.content.length, 0);
  while (result.length > 1 && totalLength() > TOTAL_OUTPUT_BUDGET) result.pop();
  return result;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function timeoutError(): ToolResult {
  return { success: false, error: `web_search 请求超时（${TIMEOUT_MS}ms）` };
}

async function searchTavily(
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<ToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // timer 覆盖到响应体读完：fetch 只返回响应头，response.text()/json()
    // 的 body 读取也可能悬挂，不能在 fetch resolve 后提前 clear
    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
      signal: controller.signal,
    });

    // 非 2xx：结构化错误（状态码 + 响应正文简述），不抛裸异常
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch (err) {
        if (isAbortError(err)) return timeoutError();
        // 读错误正文失败不致命：按无正文处理，仍返回 HTTP 结构化错误
      }
      const snippet = truncateText(detail.trim() || "无响应正文", 200);
      return {
        success: false,
        error: `web_search 请求失败：HTTP ${response.status}（${snippet}）`,
        output: { statusCode: response.status },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      if (isAbortError(err)) return timeoutError();
      return {
        success: false,
        error: `web_search 响应解析失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { success: true, output: { results: fitTotalBudget(mapResults(payload)) } };
  } catch (err) {
    if (isAbortError(err)) return timeoutError();
    return {
      success: false,
      error: `web_search 请求失败（网络错误）：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * web_search（出网工具，默认需人工审批；可「本会话免问」——
 * 不在 NO_REMEMBER_TOOLS 五高危名单内，白名单机制天然放行）。
 * 未配置 tavilyApiKey 时工具照常注册，调用返回明确错误提示配置。
 */
export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web via Tavily and return a compact list of results (title/url/content, " +
    "content truncated to ~500 chars, total output capped at ~4000 chars). " +
    "Requires tavilyApiKey in system settings; network access needs approval.",
  parameters,
  accesses: [{ resource: "network", action: "read" }],
  requiresApproval: true,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    let parsed: z.infer<typeof parameters>;
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    const configRepository = ctx.services?.configRepository;
    if (!configRepository) {
      return { success: false, error: "web_search 系统配置不可用（configRepository 未注入）" };
    }

    let config;
    try {
      config = await configRepository.load();
    } catch (err) {
      return { success: false, error: `web_search 读取系统配置失败：${String(err)}` };
    }
    const apiKey = config.settings.tavilyApiKey;
    if (!apiKey) {
      return {
        success: false,
        error: "web_search 未配置 tavilyApiKey，请在系统设置中配置后重试",
      };
    }
    return searchTavily(apiKey, parsed.query, parsed.maxResults);
  },
};

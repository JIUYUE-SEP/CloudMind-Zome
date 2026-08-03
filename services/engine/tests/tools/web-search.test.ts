import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { webSearchTool } from "../../src/tools/builtin/web-search.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ToolContext, ToolResult } from "../../src/tools/types.js";

let tmpDir: string;
let originalDataDir: string | undefined;
let configRepository: ConfigRepository;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  configRepository = new ConfigRepository();
  ctx = {
    agentId: "a1",
    workspaceDir: tmpDir,
    approve: async () => true,
    services: { configRepository },
  };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  restoreDataDir(originalDataDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedConfig(tavilyApiKey?: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, "config.json"),
    JSON.stringify({
      settings: { tavilyApiKey },
      providers: [],
    }),
    "utf-8",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function longContent(chars: number): string {
  return "x".repeat(chars);
}

describe("web_search 工具", () => {
  it("请求体形状正确：api_key/query/max_results（缺省 5、显式 7）", async () => {
    await seedConfig("tvly-test");
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const defaultResult = await webSearchTool.execute(ctx, { query: "hello world" });
    expect(defaultResult.success).toBe(true);
    const explicitResult = await webSearchTool.execute(ctx, { query: "hello world", maxResults: 7 });
    expect(explicitResult.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url1, init1] = fetchMock.mock.calls[0];
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url1).toBe("https://api.tavily.com/search");
    expect(url2).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(init1.body))).toEqual({
      api_key: "tvly-test",
      query: "hello world",
      max_results: 5,
    });
    expect(JSON.parse(String(init2.body))).toEqual({
      api_key: "tvly-test",
      query: "hello world",
      max_results: 7,
    });
    expect((init1.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("结果映射为 title/url/content，content 截断 ~500 字符，总输出预算 ~4000 字符", async () => {
    await seedConfig("tvly-test");
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `title-${i}`,
      url: `https://example.com/${i}`,
      content: longContent(600),
      score: 0.9,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results })));

    const result = await webSearchTool.execute(ctx, { query: "q" });
    expect(result.success).toBe(true);
    const mapped = (result as { output: { results: { title: string; url: string; content: string }[] } })
      .output.results;
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.length).toBeLessThan(10);
    expect(mapped[0]).toMatchObject({ title: "title-0", url: "https://example.com/0" });
    expect(mapped[0].content).toHaveLength(501);
    expect(mapped[0].content.endsWith("…")).toBe(true);
    const totalChars = mapped.reduce(
      (n, item) => n + item.title.length + item.url.length + item.content.length,
      0,
    );
    expect(totalChars).toBeLessThanOrEqual(4000);
  });

  it("未配置 tavilyApiKey：工具照常注册，调用返回明确错误且不发请求", async () => {
    await seedConfig();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute(ctx, { query: "q" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("web_search 未配置 tavilyApiKey，请在系统设置中配置后重试");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([429, 500])("HTTP %i：返回结构化错误（状态码+简述），不抛异常", async (status) => {
    await seedConfig("tvly-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited, retry later", { status })));

    const result = await webSearchTool.execute(ctx, { query: "q" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain(`HTTP ${status}`);
    expect(String(result.error)).toContain("rate limited");
    expect((result as { output?: { statusCode?: number } }).output?.statusCode).toBe(status);
  });

  it("fetch 抛错（网络失败）：返回结构化错误不抛异常", async () => {
    await seedConfig("tvly-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const result = await webSearchTool.execute(ctx, { query: "q" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("网络错误");
    expect(String(result.error)).toContain("fetch failed");
  });

  it("10s 超时：中止请求并返回超时错误", async () => {
    await seedConfig("tvly-test");
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const pending = webSearchTool.execute(ctx, { query: "q" });
      // execute 先等 config 落盘读取（真实 I/O）才创建 10s 定时器：
      // 让事件循环先跑到 fetch 被调用，再拨动假时钟触发 abort
      for (let i = 0; i < 50 && fetchMock.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fetchMock).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      const result: ToolResult = await pending;
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("超时");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requiresApproval=true、network/read 声明，且已注册进内置工具表", () => {
    expect(webSearchTool.requiresApproval).toBe(true);
    expect(webSearchTool.accesses).toContainEqual({ resource: "network", action: "read" });
    expect(getBuiltinTools().map((t) => t.name)).toContain("web_search");
    const registered = getBuiltinTools().find((t) => t.name === "web_search");
    expect(registered?.requiresApproval).toBe(true);
  });

  it("参数校验：maxResults 超上限 10 / 缺 query 返回参数错误", async () => {
    await seedConfig("tvly-test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const overCap = await webSearchTool.execute(ctx, { query: "q", maxResults: 11 });
    expect(overCap.success).toBe(false);
    expect(String(overCap.error)).toContain("maxResults");
    const missingQuery = await webSearchTool.execute(ctx, {});
    expect(missingQuery.success).toBe(false);
    expect(String(missingQuery.error)).toContain("query");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

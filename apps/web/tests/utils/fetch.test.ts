import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "@/utils/fetch";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the response when fetch resolves in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const res = await fetchWithTimeout("http://engine.test/health");
    expect(res.status).toBe(200);
  });

  it("passes an abort signal to fetch", async () => {
    const spy = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await fetchWithTimeout("http://engine.test/health");
    const init = spy.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws a Chinese timeout hint when the request times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation timed out", "TimeoutError"));
            });
          }),
      ),
    );
    await expect(fetchWithTimeout("http://engine.test/slow", undefined, 20)).rejects.toThrow(
      "请求超时，请检查 engine 是否运行",
    );
  });

  it("rethrows non-timeout errors unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new RangeError("weird failure");
      }),
    );
    await expect(fetchWithTimeout("http://engine.test/down")).rejects.toThrow("weird failure");
  });

  it("wraps network TypeError (engine 不可达) into a Chinese hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(fetchWithTimeout("http://engine.test/down")).rejects.toThrow(
      "无法连接 engine，请检查 engine 是否运行",
    );
  });
});

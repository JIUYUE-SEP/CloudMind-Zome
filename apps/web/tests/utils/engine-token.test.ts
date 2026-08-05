import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveEngineToken,
  fetchEngineTokenFromServer,
} from "@/utils/engine-token";

describe("resolveEngineToken 优先级（显式配置 > localStorage > server）", () => {
  it("显式配置压过 localStorage 与 server", () => {
    expect(resolveEngineToken("cfg-token", "local-token", "server-token")).toBe(
      "cfg-token",
    );
  });

  it("无显式配置时 localStorage 压过 server", () => {
    expect(resolveEngineToken(undefined, "local-token", "server-token")).toBe(
      "local-token",
    );
    expect(resolveEngineToken("", "local-token", "server-token")).toBe("local-token");
  });

  it("前两档缺失时回落 server token", () => {
    expect(resolveEngineToken(undefined, undefined, "server-token")).toBe(
      "server-token",
    );
  });

  it("全部缺失/空串返回空（维持 401 提示，不崩）", () => {
    expect(resolveEngineToken(undefined, undefined, undefined)).toBe("");
    expect(resolveEngineToken("", "", "")).toBe("");
  });
});

describe("fetchEngineTokenFromServer 优雅降级", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok,
          json: () => Promise.resolve(body),
        } as unknown as Response),
      ) as unknown as typeof fetch,
    );
  }

  it("成功响应带 token：返回该 token", async () => {
    stubFetch({ token: "abc123" });
    expect(await fetchEngineTokenFromServer()).toBe("abc123");
  });

  it("响应无 token / token 非字符串：返回空", async () => {
    stubFetch({});
    expect(await fetchEngineTokenFromServer()).toBe("");
    stubFetch({ token: 123 });
    expect(await fetchEngineTokenFromServer()).toBe("");
    stubFetch({ token: "" });
    expect(await fetchEngineTokenFromServer()).toBe("");
  });

  it("HTTP 错误：返回空", async () => {
    stubFetch({ error: "nope" }, false);
    expect(await fetchEngineTokenFromServer()).toBe("");
  });

  it("网络失败/读不到文件：返回空（不抛）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch,
    );
    expect(await fetchEngineTokenFromServer()).toBe("");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchEngineTokenFromServerMock } = vi.hoisted(() => ({
  fetchEngineTokenFromServerMock: vi.fn(),
}));

vi.mock("@/utils/engine-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/engine-token")>();
  return {
    ...actual,
    // 就绪链的 server 拉取由各测试注入 deferred / 立即值，避免真发网络请求
    fetchEngineTokenFromServer: fetchEngineTokenFromServerMock,
  };
});

// 就绪链在 mock 下全走微任务（无定时器）：连续 await 排空即可，不用 sleep
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  send(_data: string) {}
  close() {
    this.readyState = 3;
  }
}

function okResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

describe("useEngineClient token 就绪（真机 #12）", () => {
  beforeEach(() => {
    // 就绪 Promise 是模块级单例：每个用例重新加载模块，拿到干净状态
    vi.resetModules();
    fetchEngineTokenFromServerMock.mockReset();
    MockWebSocket.instances = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("token 未就绪时发起的 engineFetch 会等待，请求发出时已注入 Bearer token", async () => {
    let resolveToken!: (token: string) => void;
    fetchEngineTokenFromServerMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve;
      }),
    );

    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(okResponse({})),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const pending = client.listAgents();
    await flushMicrotasks();
    // server 档尚未 resolve：engineFetch 必须原地等待，不得抢跑发请求
    expect(fetchSpy).not.toHaveBeenCalled();

    resolveToken("secret");
    await expect(pending).resolves.toEqual({});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret");
  });

  it("token 就绪只拉一次 server：重复 engineFetch / 重复 useEngineClient 不重复请求", async () => {
    fetchEngineTokenFromServerMock.mockResolvedValue("cached");
    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(okResponse({}))),
    );

    await client.listAgents();
    await client.listSessions();
    const again = useEngineClient();
    await again.getConfig();

    expect(fetchEngineTokenFromServerMock).toHaveBeenCalledTimes(1);
  });

  it("拉取失败/空 token 时正常降级：请求照发，401 由界面层透出", async () => {
    fetchEngineTokenFromServerMock.mockResolvedValue("");
    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Unauthorized" }),
      } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.listAgents()).rejects.toThrow("Failed to list agents: Unauthorized");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
  });

  it("WS 建连前等 token 就绪，并以子协议携带 token", async () => {
    let resolveToken!: (token: string) => void;
    fetchEngineTokenFromServerMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve;
      }),
    );

    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();

    client.connect("a1", "s1", {});
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(0);

    resolveToken("ws-secret");
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.protocols).toBe("ws-secret");
  });

  it("显式/local token 时直接就绪，不拉 server", async () => {
    localStorage.setItem("cloudmind.engineToken", "local-secret");
    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(okResponse({})),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await client.listAgents();

    expect(fetchEngineTokenFromServerMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer local-secret");
  });

  it("A6：401 后作废 token 就绪缓存，二次调用重取新 token", async () => {
    fetchEngineTokenFromServerMock
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("fresh");
    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Unauthorized" }),
      } as unknown as Response)
      .mockResolvedValueOnce(okResponse({}));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.listAgents()).rejects.toThrow("Failed to list agents: Unauthorized");
    await expect(client.listSessions()).resolves.toEqual({});

    // 第一次取 token 失败（401）后第二次调用重新拉取 server 档，而不是复用旧缓存
    expect(fetchEngineTokenFromServerMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchSpy.mock.calls[1]![1]!;
    expect(new Headers(secondInit.headers).get("Authorization")).toBe("Bearer fresh");
  });

  it("A6：WS 构造 SyntaxError 清 localStorage 残留 token 并重取重连", async () => {
    localStorage.setItem("cloudmind.engineToken", "bad token!");
    fetchEngineTokenFromServerMock.mockResolvedValue("fresh");

    // 浏览器对含非法字符（如空格）的子协议抛 SyntaxError
    class ThrowingWebSocket extends MockWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        if (protocols === "bad token!") {
          throw new DOMException("invalid subprotocol", "SyntaxError");
        }
      }
    }
    vi.stubGlobal("WebSocket", ThrowingWebSocket);

    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    client.connect("a1", "s1", {});
    await flushMicrotasks();
    // 第一次构造抛 SyntaxError：清 localStorage + 作废就绪缓存，重取后第二次建连成功
    await flushMicrotasks();

    expect(localStorage.getItem("cloudmind.engineToken")).toBeNull();
    expect(fetchEngineTokenFromServerMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances.at(-1)!.protocols).toBe("fresh");
  });

  it("F4：REST 401 清 localStorage 陈旧 token，二次调用走 server 档重取", async () => {
    localStorage.setItem("cloudmind.engineToken", "stale-local");
    fetchEngineTokenFromServerMock.mockResolvedValue("fresh-server");
    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Unauthorized" }),
      } as unknown as Response)
      .mockResolvedValueOnce(okResponse({}));
    vi.stubGlobal("fetch", fetchSpy);

    // 陈旧 localStorage 档首轮短路（不拉 server），401 后必须清掉
    await expect(client.listAgents()).rejects.toThrow("Failed to list agents: Unauthorized");
    expect(localStorage.getItem("cloudmind.engineToken")).toBeNull();

    // 二次调用：local 档已清，走 server 档拿到新 token
    await expect(client.listSessions()).resolves.toEqual({});
    expect(fetchEngineTokenFromServerMock).toHaveBeenCalledTimes(1);
    const secondInit = fetchSpy.mock.calls[1]![1]!;
    expect(new Headers(secondInit.headers).get("Authorization")).toBe("Bearer fresh-server");
  });

  it("F4：WS 4401 清 localStorage 陈旧 token，下次建连走 server 档重取", async () => {
    localStorage.setItem("cloudmind.engineToken", "stale-local");
    fetchEngineTokenFromServerMock.mockResolvedValue("fresh-server");
    const { useEngineClient } = await import("@/composables/useEngineClient");
    const client = useEngineClient();
    client.connect("a1", "s1", {});
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.protocols).toBe("stale-local");

    // engine 以 4401（token 失效）关闭：清内存 + 清 localStorage
    MockWebSocket.instances[0]!.onclose?.({ code: 4401 });
    expect(localStorage.getItem("cloudmind.engineToken")).toBeNull();

    // M43：不干等人工恢复——重取 server 档新 token 后自动重建一次
    await flushMicrotasks();
    expect(fetchEngineTokenFromServerMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]!.protocols).toBe("fresh-server");

    // 下次建连复用已重取的 token（server 档不重复拉取）
    client.connect("a2", "s2", {});
    await flushMicrotasks();
    expect(fetchEngineTokenFromServerMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances.at(-1)!.protocols).toBe("fresh-server");
  });
});

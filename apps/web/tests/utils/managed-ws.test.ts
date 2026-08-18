import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createManagedWsConnection,
  type ManagedWsDeps,
} from "@/utils/managed-ws";

// 与 useEngineClient.test.ts 同款可手动驱动的 WS Mock：open 模拟握手成功，drop 模拟断开
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
    this.onclose?.({ code: 1000, reason: "" });
  }
  // 测试驱动：握手成功
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  // 测试驱动：连接断开（1006 异常断开 / 4xxx 终态业务码）
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function lastSocket(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error("no WebSocket instance created");
  return ws;
}

// 就绪链在直测里全走微任务（无定时器）：连续 await 排空即可
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeDeps(overrides?: Partial<ManagedWsDeps>): ManagedWsDeps {
  return {
    getToken: () => "tok",
    ensureTokenReady: () => Promise.resolve("tok"),
    invalidateToken: vi.fn(),
    ...overrides,
  };
}

describe("managed-ws 连接管理器生命周期（D2 共享层直测）", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("建连前等 token 就绪：就绪前不建连，就绪后 token 经子协议传递", async () => {
    let resolveReady!: (token: string) => void;
    const deps = makeDeps({
      ensureTokenReady: () =>
        new Promise<string>((resolve) => {
          resolveReady = resolve;
        }),
    });
    createManagedWsConnection("ws://localhost/ws/a1", {}, false, deps);
    await flush();
    expect(MockWebSocket.instances).toHaveLength(0);

    resolveReady("tok");
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.protocols).toBe("tok");
  });

  it("无 token 直接建连，不带子协议", async () => {
    const deps = makeDeps({ getToken: () => "" });
    createManagedWsConnection("ws://localhost/ws/a1", {}, false, deps);
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.protocols).toBeUndefined();
  });

  it("异常断开按 1s/2s 退避重连；首连不触发 onReconnected，重连成功才触发", async () => {
    const onOpen = vi.fn();
    const onReconnecting = vi.fn();
    const onReconnected = vi.fn();
    createManagedWsConnection("ws://localhost/ws/a1", { onOpen, onReconnecting, onReconnected }, false, makeDeps());
    await flush();

    lastSocket().open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onReconnected).not.toHaveBeenCalled();

    lastSocket().drop(1006);
    expect(onReconnecting).toHaveBeenLastCalledWith(1, 1000);
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // 未成功握手又断：退避指数增长
    lastSocket().drop(1006);
    expect(onReconnecting).toHaveBeenLastCalledWith(2, 2000);
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(3);

    lastSocket().open();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });

  it("终态关闭码（4001）透传 onClose，不重连", async () => {
    const onClose = vi.fn();
    const onReconnecting = vi.fn();
    createManagedWsConnection("ws://localhost/ws/a1", { onClose, onReconnecting }, false, makeDeps());
    await flush();
    lastSocket().open();

    lastSocket().drop(4001, "Agent not found");
    expect(onClose).toHaveBeenCalledWith(4001, "Agent not found");
    expect(onReconnecting).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("4401：作废旧 token 重取后自动重建一次（M43），重建成功按断线重连语义触发 onReconnected", async () => {
    let token = "stale";
    const invalidateToken = vi.fn(() => {
      token = "fresh";
    });
    const deps = makeDeps({
      getToken: () => token,
      ensureTokenReady: () => Promise.resolve(token),
      invalidateToken,
    });
    const onClose = vi.fn();
    const onReconnecting = vi.fn();
    const onReconnected = vi.fn();
    createManagedWsConnection("ws://localhost/ws/a1", { onClose, onReconnecting, onReconnected }, false, deps);
    await flush();
    expect(MockWebSocket.instances[0]!.protocols).toBe("stale");
    lastSocket().open();

    lastSocket().drop(4401, "invalid token");
    // 失效点先作废旧 token，不落终态分支
    expect(invalidateToken).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onReconnecting).toHaveBeenCalledWith(1, 0);
    // 重取新 token 后无退避立即重建
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]!.protocols).toBe("fresh");

    lastSocket().open();
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });

  it("4401 重建一次仍 4401：闩锁停重建，透传 onClose 人工恢复（M43）", async () => {
    const onClose = vi.fn();
    const onReconnecting = vi.fn();
    createManagedWsConnection("ws://localhost/ws/a1", { onClose, onReconnecting }, false, makeDeps());
    await flush();
    lastSocket().open();

    lastSocket().drop(4401);
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);

    lastSocket().drop(4401, "token still invalid");
    expect(onClose).toHaveBeenCalledWith(4401, "token still invalid");
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(onReconnecting).toHaveBeenCalledTimes(1);
  });

  it("4401 重建链重取 token 失败：catch 落终态透传 onClose（A4 验证遗留补漏）", async () => {
    const ensureTokenReady = vi
      .fn()
      // 首次建连就绪成功
      .mockResolvedValueOnce("tok")
      // 4401 后的重取失败（如 IPC/网络异常）
      .mockRejectedValueOnce(new Error("ipc down"));
    const onClose = vi.fn();
    const onReconnecting = vi.fn();
    createManagedWsConnection("ws://localhost/ws/a1", { onClose, onReconnecting }, false, makeDeps({ ensureTokenReady }));
    await flush();
    lastSocket().open();

    lastSocket().drop(4401, "invalid token");
    expect(onReconnecting).toHaveBeenCalledWith(1, 0);
    await flush();
    // 不得悬在既不重建也不透传的中间态（且不得 unhandled rejection——有则本用例直接红）
    expect(onClose).toHaveBeenCalledWith(4401, "invalid token");
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("初始建连的 token 就绪失败：catch 落终态透传 onError（不 unhandled rejection）", async () => {
    const ensureTokenReady = vi.fn().mockRejectedValue(new Error("ipc down"));
    const onError = vi.fn();
    const onOpen = vi.fn();
    createManagedWsConnection("ws://localhost/ws/a1", { onError, onOpen }, false, makeDeps({ ensureTokenReady }));
    await flush();
    // 就绪失败：不得建连、不得悬在既不建连也不透传的中间态
    // （初始链无 catch 时这里是 unhandled rejection，本用例直接红）
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("WebSocket error");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("调用方 close() 后不再重连", async () => {
    const onClose = vi.fn();
    const onReconnecting = vi.fn();
    const conn = createManagedWsConnection("ws://localhost/ws/a1", { onClose, onReconnecting }, false, makeDeps());
    await flush();
    lastSocket().open();

    conn.close();
    expect(onClose).toHaveBeenCalledWith(1000, "");
    expect(onReconnecting).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("帧路由：会话帧透出 agentId，私聊帧保持单参数", async () => {
    const onSessionDelta = vi.fn();
    createManagedWsConnection("ws://localhost/ws/sessions/s1", { onTextDelta: onSessionDelta }, true, makeDeps());
    const onPrivateDelta = vi.fn();
    createManagedWsConnection("ws://localhost/ws/a1", { onTextDelta: onPrivateDelta }, false, makeDeps());
    await flush();

    MockWebSocket.instances[0]!.onmessage?.({
      data: JSON.stringify({ type: "text.delta", delta: "群聊", agentId: "a1" }),
    });
    expect(onSessionDelta).toHaveBeenCalledWith("群聊", "a1");

    MockWebSocket.instances[1]!.onmessage?.({
      data: JSON.stringify({ type: "text.delta", delta: "私聊" }),
    });
    expect(onPrivateDelta).toHaveBeenCalledWith("私聊");
  });
});

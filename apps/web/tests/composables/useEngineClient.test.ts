import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEngineClient } from "@/composables/useEngineClient";

// token 就绪链不真发 /api/engine-token：立即 resolve 空串，行为等同“无 token 降级”
vi.mock("@/utils/engine-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/engine-token")>();
  return {
    ...actual,
    fetchEngineTokenFromServer: vi.fn(async () => ""),
  };
});

// 建连现在要等 token 就绪（微任务链，mock 下无定时器）：连续 await 排空即可
async function flushTokenReady(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// 捕获 WebSocket 实例，手动驱动 onmessage 验证帧路由
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(_data: string) {}
  close() {
    this.readyState = 3;
  }
}

function lastSocket(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error("no WebSocket instance created");
  return ws;
}

describe("useEngineClient WS 帧路由", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connect: thinking.delta 帧路由到 onThinkingDelta（与 engine 帧名一致）", async () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    const onTextDelta = vi.fn();
    client.connect("agent-1", "default", { onThinkingDelta, onTextDelta });
    await flushTokenReady();

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "thinking.delta", delta: "先想一下" }) });
    expect(onThinkingDelta).toHaveBeenCalledWith("先想一下");

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "text.delta", delta: "正文" }) });
    expect(onTextDelta).toHaveBeenCalledWith("正文");
  });

  it("connectSession: thinking.delta 帧同样路由，并透出群聊帧携带的 agentId", async () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    const onTextDelta = vi.fn();
    const onStepEnd = vi.fn();
    client.connectSession("session-1", { onThinkingDelta, onTextDelta, onStepEnd });
    await flushTokenReady();

    lastSocket().onmessage?.({
      data: JSON.stringify({ type: "thinking.delta", delta: "群聊思考", agentId: "a1" }),
    });
    expect(onThinkingDelta).toHaveBeenCalledWith("群聊思考", "a1");

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "text.delta", delta: "正文", agentId: "a2" }) });
    expect(onTextDelta).toHaveBeenCalledWith("正文", "a2");

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "step.end", agentId: "a1" }) });
    expect(onStepEnd).toHaveBeenCalledWith(undefined, "a1");

    // 私聊帧不带 agentId 时为 undefined
    lastSocket().onmessage?.({ data: JSON.stringify({ type: "text.delta", delta: "无归属" }) });
    expect(onTextDelta).toHaveBeenCalledWith("无归属", undefined);
  });

  it("turn.end 帧路由到 onTurnEnd（群聊透出 agentId，私聊为 undefined）", async () => {
    const client = useEngineClient();
    const onTurnEnd = vi.fn();
    client.connectSession("session-1", { onTurnEnd });
    await flushTokenReady();
    lastSocket().onmessage?.({ data: JSON.stringify({ type: "turn.end", agentId: "a1" }) });
    expect(onTurnEnd).toHaveBeenCalledWith("a1");

    const onPrivateTurnEnd = vi.fn();
    client.connect("agent-1", "default", { onTurnEnd: onPrivateTurnEnd });
    await flushTokenReady();
    lastSocket().onmessage?.({ data: JSON.stringify({ type: "turn.end" }) });
    expect(onPrivateTurnEnd).toHaveBeenCalledWith();
  });

  it("旧的 think.delta 帧名不再路由（engine 只发 thinking.delta）", async () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    client.connect("agent-1", "default", { onThinkingDelta });
    await flushTokenReady();

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "think.delta", delta: "旧帧名" }) });
    expect(onThinkingDelta).not.toHaveBeenCalled();
  });

  it("handoff.update 帧路由到 onHandoffUpdate", async () => {
    const client = useEngineClient();
    const onHandoffUpdate = vi.fn();
    client.connect("agent-1", "default", { onHandoffUpdate });
    await flushTokenReady();

    lastSocket().onmessage?.({
      data: JSON.stringify({
        type: "handoff.update",
        status: "running",
        shift: 2,
        maxShifts: 3,
        bookMessageId: "msg_book",
      }),
    });
    expect(onHandoffUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handoff.update", status: "running", shift: 2, maxShifts: 3 }),
    );
  });
});

describe("useEngineClient REST 错误透出", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubErrorResponse(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status,
          json: () => Promise.resolve(body),
        } as unknown as Response),
      ),
    );
  }

  it("!res.ok 时透出响应体的 error 字段", async () => {
    stubErrorResponse(400, { error: "Invalid agent id" });
    const client = useEngineClient();
    await expect(
      client.createAgent({ id: "中文", name: "x", persona: "", skills: [], tools: [] }),
    ).rejects.toThrow("Failed to create agent: Invalid agent id");
  });

  it("响应体无 error 字段时退回状态码", async () => {
    stubErrorResponse(502, { message: "bad gateway" });
    const client = useEngineClient();
    await expect(client.listAgents()).rejects.toThrow("Failed to list agents: 502");
  });

  it("响应体非 JSON 时退回状态码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error("not json")),
        } as unknown as Response),
      ),
    );
    const client = useEngineClient();
    await expect(client.listAgents()).rejects.toThrow("Failed to list agents: 500");
  });
});

describe("useEngineClient URL 路径段编码", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureUrl() {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        urls.push(String(input));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
      }) as unknown as typeof fetch,
    );
    return urls;
  }

  it("含斜杠的 modelId 被编码，URL 不多出路径段", async () => {
    const urls = captureUrl();
    const client = useEngineClient();
    await client.updateModel("p1", "openai/gpt-4o", { displayName: "GPT-4o" });
    expect(urls[0]).toContain("/compute/providers/p1/models/openai%2Fgpt-4o");

    await client.deleteModel("p1", "openai/gpt-4o");
    expect(urls[1]).toContain("/models/openai%2Fgpt-4o");
  });

  it("providerId / sessionId / taskId / blueprintId 均编码", async () => {
    const urls = captureUrl();
    const client = useEngineClient();
    await client.deleteProvider("my provider");
    expect(urls[0]).toContain("/compute/providers/my%20provider");

    await client.updateSession("s 1", { name: "x" });
    expect(urls[1]).toContain("/sessions/s%201");

    await client.deleteScheduledTask("a1", "task/1");
    expect(urls[2]).toContain("/scheduler/a1/task%2F1");

    await client.getBlueprint("bp 1");
    expect(urls[3]).toContain("/blueprints/bp%201");
  });
});

// 重连测试用 Mock：可手动驱动 open/drop，记录全部实例
class ReconnectMockWebSocket {
  static instances: ReconnectMockWebSocket[] = [];
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
    ReconnectMockWebSocket.instances.push(this);
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
  // 测试驱动：连接被拒（浏览器真实行为：先 fire error 再 fire close 1006）
  fail() {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.({ code: 1006, reason: "" });
  }
}

function lastReconnectSocket(): ReconnectMockWebSocket {
  const ws = ReconnectMockWebSocket.instances[ReconnectMockWebSocket.instances.length - 1];
  if (!ws) throw new Error("no WebSocket instance created");
  return ws;
}

describe("useEngineClient WS 自动重连（P0-3）", () => {
  beforeEach(() => {
    ReconnectMockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", ReconnectMockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("异常断开（1006）后按 1s 退避自动重连，重连成功触发 onReconnected", async () => {
    const client = useEngineClient();
    const onOpen = vi.fn();
    const onReconnecting = vi.fn();
    const onReconnected = vi.fn();
    const onClose = vi.fn();
    client.connect("agent-1", "default", { onOpen, onReconnecting, onReconnected, onClose });
    await flushTokenReady();

    lastReconnectSocket().open();
    expect(onOpen).toHaveBeenCalledTimes(1);

    lastReconnectSocket().drop(1006);
    expect(onReconnecting).toHaveBeenCalledWith(1, 1000);
    expect(onClose).not.toHaveBeenCalled();
    expect(ReconnectMockWebSocket.instances).toHaveLength(1);

    // 退避未到不发起新连接；到点立即重连
    vi.advanceTimersByTime(999);
    expect(ReconnectMockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ReconnectMockWebSocket.instances).toHaveLength(2);

    lastReconnectSocket().open();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });

  it("退避间隔 1s/2s/4s…指数增长并封顶 30s", async () => {
    const client = useEngineClient();
    const onReconnecting = vi.fn();
    client.connect("agent-1", "default", { onReconnecting });
    await flushTokenReady();
    lastReconnectSocket().open();

    const delays: number[] = [];
    for (let n = 1; n <= 7; n++) {
      lastReconnectSocket().drop(1006);
      delays.push(onReconnecting.mock.calls[n - 1][1] as number);
      vi.advanceTimersByTime(delays[n - 1]);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    // 永不放弃：每次都发起了新连接
    expect(ReconnectMockWebSocket.instances).toHaveLength(8);
  });

  it("终态关闭码（4001 agent 不存在）不重连，onClose 原样透传", async () => {
    const client = useEngineClient();
    const onClose = vi.fn();
    const onReconnecting = vi.fn();
    client.connect("agent-1", "default", { onClose, onReconnecting });
    await flushTokenReady();
    lastReconnectSocket().open();

    lastReconnectSocket().drop(4001, "Agent not found");
    expect(onClose).toHaveBeenCalledWith(4001, "Agent not found");
    expect(onReconnecting).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(ReconnectMockWebSocket.instances).toHaveLength(1);
  });

  it("调用方 close() 后不再重连", async () => {
    const client = useEngineClient();
    const onReconnecting = vi.fn();
    const onClose = vi.fn();
    const conn = client.connect("agent-1", "default", { onReconnecting, onClose });
    await flushTokenReady();
    lastReconnectSocket().open();

    conn.close();
    expect(onClose).toHaveBeenCalledWith(1000, "");
    expect(onReconnecting).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(ReconnectMockWebSocket.instances).toHaveLength(1);
  });

  it("首次握手即失败也进入重连，但不算 onReconnected", async () => {
    const client = useEngineClient();
    const onOpen = vi.fn();
    const onReconnecting = vi.fn();
    const onReconnected = vi.fn();
    client.connect("agent-1", "default", { onOpen, onReconnecting, onReconnected });
    await flushTokenReady();

    // engine 未起：首次握手直接失败
    lastReconnectSocket().drop(1006);
    expect(onReconnecting).toHaveBeenCalledWith(1, 1000);

    vi.advanceTimersByTime(1000);
    lastReconnectSocket().open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it("重连期间 onError 不刷气泡（P0 review 返工）", async () => {
    const client = useEngineClient();
    const onError = vi.fn();
    const onReconnecting = vi.fn();
    client.connect("agent-1", "default", { onError, onReconnecting });
    await flushTokenReady();
    lastReconnectSocket().open();

    // 模拟 engine 停机期间连接被拒：每次失败尝试 error + close(1006) 连续触发
    for (let n = 0; n < 10; n++) {
      lastReconnectSocket().fail();
      vi.advanceTimersByTime(30_000);
    }
    expect(onReconnecting).toHaveBeenCalledTimes(10);
    expect(onError).not.toHaveBeenCalled();
  });

  it("首连失败只透传一次 onError，后续失败尝试不再刷（P0 review 返工）", async () => {
    const client = useEngineClient();
    const onError = vi.fn();
    client.connect("agent-1", "default", { onError });
    await flushTokenReady();

    for (let n = 0; n < 5; n++) {
      lastReconnectSocket().fail();
      vi.advanceTimersByTime(30_000);
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("WebSocket error");
  });
});

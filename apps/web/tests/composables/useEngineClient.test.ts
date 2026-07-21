import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEngineClient } from "@/composables/useEngineClient";

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

  it("connect: thinking.delta 帧路由到 onThinkingDelta（与 engine 帧名一致）", () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    const onTextDelta = vi.fn();
    client.connect("agent-1", "default", { onThinkingDelta, onTextDelta });

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "thinking.delta", delta: "先想一下" }) });
    expect(onThinkingDelta).toHaveBeenCalledWith("先想一下");

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "text.delta", delta: "正文" }) });
    expect(onTextDelta).toHaveBeenCalledWith("正文");
  });

  it("connectSession: thinking.delta 帧同样路由，并透出群聊帧携带的 agentId", () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    const onTextDelta = vi.fn();
    const onStepEnd = vi.fn();
    client.connectSession("session-1", { onThinkingDelta, onTextDelta, onStepEnd });

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

  it("turn.end 帧路由到 onTurnEnd（群聊透出 agentId，私聊为 undefined）", () => {
    const client = useEngineClient();
    const onTurnEnd = vi.fn();
    client.connectSession("session-1", { onTurnEnd });
    lastSocket().onmessage?.({ data: JSON.stringify({ type: "turn.end", agentId: "a1" }) });
    expect(onTurnEnd).toHaveBeenCalledWith("a1");

    const onPrivateTurnEnd = vi.fn();
    client.connect("agent-1", "default", { onTurnEnd: onPrivateTurnEnd });
    lastSocket().onmessage?.({ data: JSON.stringify({ type: "turn.end" }) });
    expect(onPrivateTurnEnd).toHaveBeenCalledWith();
  });

  it("旧的 think.delta 帧名不再路由（engine 只发 thinking.delta）", () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    client.connect("agent-1", "default", { onThinkingDelta });

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "think.delta", delta: "旧帧名" }) });
    expect(onThinkingDelta).not.toHaveBeenCalled();
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

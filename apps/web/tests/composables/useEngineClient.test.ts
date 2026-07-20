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

  it("connectSession: thinking.delta 帧同样路由", () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    client.connectSession("session-1", { onThinkingDelta });

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "thinking.delta", delta: "群聊思考" }) });
    expect(onThinkingDelta).toHaveBeenCalledWith("群聊思考");
  });

  it("旧的 think.delta 帧名不再路由（engine 只发 thinking.delta）", () => {
    const client = useEngineClient();
    const onThinkingDelta = vi.fn();
    client.connect("agent-1", "default", { onThinkingDelta });

    lastSocket().onmessage?.({ data: JSON.stringify({ type: "think.delta", delta: "旧帧名" }) });
    expect(onThinkingDelta).not.toHaveBeenCalled();
  });
});

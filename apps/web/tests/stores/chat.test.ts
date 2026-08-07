import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "@/stores/chat";

function makeRecord(id: string, text: string) {
  return {
    id,
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

function jsonDelayed(body: unknown, ms: number) {
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response),
      ms,
    ),
  );
}

describe("chat store 历史加载竞态", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("后切换的会话优先：先发起的慢加载结果被丢弃", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        // A 的历史慢返回，B 的快返回：模拟快速从 A 切到 B
        return url.includes("/chat/a/")
          ? jsonDelayed([makeRecord("m-a", "A 的历史")], 30)
          : jsonDelayed([makeRecord("m-b", "B 的历史")], 0);
      }) as unknown as typeof fetch,
    );

    const store = useChatStore();
    const p1 = store.loadMessages("a");
    const p2 = store.loadMessages("b");
    await Promise.all([p1, p2]);

    expect(store.messages.map((m) => m.id)).toEqual(["m-b"]);
    expect(store.messages[0]!.text).toBe("B 的历史");
  });

  it("disconnect 后在途加载结果不再落地", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonDelayed([makeRecord("m-a", "A 的历史")], 20)) as unknown as typeof fetch,
    );

    const store = useChatStore();
    const p = store.loadMessages("a");
    store.disconnect();
    await p;

    expect(store.messages).toEqual([]);
  });
});

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send() {
    return true;
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("chat store 流式状态以 turn 为界", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function connectAndSend() {
    const store = useChatStore();
    store.connect("a1");
    await new Promise((r) => setTimeout(r, 0));
    store.send("hi");
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const frame = (data: unknown) => ws.onmessage?.({ data: JSON.stringify(data) });
    return { store, ws, frame };
  }

  it("step.end 不复位输入锁定，同一 turn 多步进同一气泡，turn.end 才解锁", async () => {
    const { store, frame } = await connectAndSend();

    frame({ type: "text.delta", delta: "先" });
    expect(store.isStreaming).toBe(true);

    // step.end 只是步骤边界（本例随后还有工具调用与下一步文本）
    frame({ type: "step.end", finishReason: "tool_use" });
    expect(store.isStreaming).toBe(true);
    expect(store.messages.at(-1)!.isStreaming).toBe(true);

    frame({ type: "tool.call", toolCallId: "t1", name: "search", arguments: {} });
    frame({ type: "text.delta", delta: "后" });
    const assistants = store.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe("先后");
    expect(assistants[0]!.toolCalls).toHaveLength(1);

    frame({ type: "turn.end" });
    expect(store.isStreaming).toBe(false);
    expect(store.messages.at(-1)!.isStreaming).toBe(false);
  });

  it("thinking.delta 先于正文到达：建立流式气泡累积思考，正文进同一气泡", async () => {
    const store = useChatStore();
    store.connect("a1");
    await new Promise((r) => setTimeout(r, 0));
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const frame = (data: unknown) => ws.onmessage?.({ data: JSON.stringify(data) });

    frame({ type: "thinking.delta", delta: "想一" });
    frame({ type: "thinking.delta", delta: "想二" });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]!.thinking).toBe("想一想二");
    expect(store.messages[0]!.isStreaming).toBe(true);

    frame({ type: "text.delta", delta: "答" });
    expect(store.messages[0]!.text).toBe("答");

    frame({ type: "turn.end" });
    expect(store.messages[0]!.isStreaming).toBe(false);
    expect(store.messages[0]!.thinking).toBe("想一想二");
  });

  it("连接干净关闭时复位流式态", async () => {
    const { store, ws, frame } = await connectAndSend();
    frame({ type: "text.delta", delta: "半截" });
    expect(store.isStreaming).toBe(true);

    ws.onclose?.();
    expect(store.isStreaming).toBe(false);
    expect(store.messages.at(-1)!.isStreaming).toBe(false);
  });

  it("过期连接的迟发帧被丢弃，不写脏新会话", async () => {
    const store = useChatStore();
    store.connect("a1");
    await new Promise((r) => setTimeout(r, 0));
    const oldWs = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;

    // 切到新连接（旧 socket 的关闭握手尚未完成）
    store.connect("a2");
    await new Promise((r) => setTimeout(r, 0));
    // 建连现在先等 token 就绪（微任务）再 new WebSocket：onopen 定时器比
    // 测试自身的 flush 晚一拍，再排空一轮事件循环
    await new Promise((r) => setTimeout(r, 0));

    oldWs.onmessage?.({ data: JSON.stringify({ type: "text.delta", delta: "旧连接的帧" }) });
    oldWs.onclose?.();

    expect(store.messages).toEqual([]);
    expect(store.isConnected).toBe(true);
  });
});

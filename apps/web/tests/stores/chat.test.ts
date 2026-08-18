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
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

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

  it("零文本直接 tool.call：自动建流式槽挂徽章，后续正文进同一槽（F13）", async () => {
    const { store, frame } = await connectAndSend();
    // 模型无正文直接调工具：此刻 last 是 user 气泡，此前徽章被静默丢弃
    frame({ type: "tool.call", toolCallId: "t1", name: "search", arguments: {} });
    const assistants = () => store.messages.filter((m) => m.role === "assistant");
    expect(assistants()).toHaveLength(1);
    expect(assistants()[0]!.toolCalls).toHaveLength(1);
    expect(assistants()[0]!.toolCalls[0]).toMatchObject({ toolCallId: "t1", name: "search" });
    expect(assistants()[0]!.isStreaming).toBe(true);

    // 工具结果可回写该徽章状态
    frame({ type: "tool.result", toolCallId: "t1", output: "ok" });
    expect(assistants()[0]!.toolCalls[0]!.status).toBe("done");

    // 同一 turn 后到的正文合并进同一槽（与群聊 slotFor 同口径），不开新气泡
    frame({ type: "text.delta", delta: "查到了" });
    expect(assistants()).toHaveLength(1);
    expect(assistants()[0]!.text).toBe("查到了");

    frame({ type: "turn.end" });
    expect(assistants()[0]!.isStreaming).toBe(false);
    expect(store.isStreaming).toBe(false);
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

  it("异常断开进重连时 pending 审批卡片标为 expired（M44 断线即失效）", async () => {
    const { store, ws, frame } = await connectAndSend();
    frame({
      type: "tool.approval_request",
      approvalId: "ap1",
      toolCallId: "t1",
      toolName: "run_command",
      arguments: { command: "rm -rf /tmp/x" },
    });
    const card = () => store.messages.find((m) => m.approval);
    expect(card()?.approval?.status).toBe("pending");

    // 无关闭码 = 异常断开 → onReconnecting；engine 侧 pending 审批已随连接按拒绝收尾
    ws.onclose?.();
    expect(card()?.approval?.status).toBe("expired");
    store.disconnect();
  });

  it("终态关闭（4403 冲突）时 pending 审批卡片同样标为 expired（M44）", async () => {
    const { store, ws, frame } = await connectAndSend();
    frame({
      type: "tool.approval_request",
      approvalId: "ap1",
      toolCallId: "t1",
      toolName: "run_command",
      arguments: { command: "rm -rf /tmp/x" },
    });
    const card = () => store.messages.find((m) => m.approval);
    expect(card()?.approval?.status).toBe("pending");

    ws.onclose?.({ code: 4403, reason: "会话已被其他连接占用" });
    expect(card()?.approval?.status).toBe("expired");
    store.disconnect();
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

  it("handoff.update 帧更新换班状态；用户发送消息即清状态（abort 打断）", async () => {
    const store = useChatStore();
    store.connect("a1");
    await new Promise((r) => setTimeout(r, 0));
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const frame = (data: unknown) => ws.onmessage?.({ data: JSON.stringify(data) });

    frame({ type: "handoff.update", status: "scheduled", shift: 1, maxShifts: 3 });
    expect(store.handoffStatus).toMatchObject({ status: "scheduled", shift: 1, maxShifts: 3 });

    frame({ type: "handoff.update", status: "running", shift: 2, maxShifts: 3 });
    expect(store.handoffStatus?.status).toBe("running");

    // 用户消息 = abort 打断：本地立即清状态（engine 收到消息即取消续跑链）
    store.send("打断");
    expect(store.handoffStatus).toBeNull();

    // 终态帧同样清状态
    frame({ type: "handoff.update", status: "fused", shift: 3, maxShifts: 3 });
    expect(store.handoffStatus?.status).toBe("fused");
    frame({ type: "handoff.update", status: "completed", shift: 3, maxShifts: 3 });
    expect(store.handoffStatus?.status).toBe("completed");
  });

  it("重连成功后补拉 handoff 状态对齐（onReconnected，R5）", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/handoff")
        ? [
            {
              id: "ho_a1_default",
              agentId: "a1",
              sessionId: "default",
              reason: "watermark",
              status: "aborted",
              shift: 2,
              maxShifts: 5,
              bookText: "[交接书] 换班移交",
              used: 950,
              window: 1000,
              createdAt: 1,
              updatedAt: 2,
              abortReason: "disconnect",
            },
          ]
        : [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = useChatStore();
    store.connect("a1");
    await vi.advanceTimersByTimeAsync(0);
    const ws1 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    ws1.onopen?.();
    ws1.onclose?.();

    // 1s 退避后重连成功：onReconnected 应拉取 /handoff 回填横幅状态
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    expect(ws2).not.toBe(ws1);
    ws2.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.handoffStatus).toMatchObject({
      status: "aborted",
      shift: 2,
      maxShifts: 5,
      reason: "disconnect",
    });

    store.disconnect();
    vi.useRealTimers();
  });
});

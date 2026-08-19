import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import ChatView from "../../components/ChatView.vue";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
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

describe("ChatView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      } as unknown as Response),
    );
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MockWebSocket.instances.forEach((ws) => ws.close());
  });

  it("renders chat view for an agent", () => {
    const wrapper = mount(ChatView, {
      props: { agentId: "a1" },
    });
    expect(wrapper.find(".chat-view").exists()).toBe(true);
    expect(wrapper.find(".status").text()).toContain("未连接");
  });

  it("sends a message when input is submitted", async () => {
    const wrapper = mount(ChatView, {
      props: { agentId: "a1" },
    });
    await flushPromises();
    const input = wrapper.find(".message-input input");
    await input.setValue("hello");
    await input.trigger("keydown.enter");
    await flushPromises();
    expect(wrapper.findAll(".message-bubble").length).toBe(1);
  });

  it("thinking.delta 帧到达即渲染：两帧拼接显示，折叠区有进行中指示", async () => {
    const wrapper = mount(ChatView, {
      props: { agentId: "a1" },
    });
    await flushPromises();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const push = (frame: unknown) => ws.onmessage?.({ data: JSON.stringify(frame) });

    push({ type: "thinking.delta", delta: "先想一" });
    push({ type: "thinking.delta", delta: "想二" });
    await flushPromises();

    expect(wrapper.findAll(".message-bubble")).toHaveLength(1);
    expect(wrapper.find(".thinking-block").exists()).toBe(true);
    expect(wrapper.find(".thinking-body").text()).toBe("先想一想二");
    expect(wrapper.find(".thinking-hint").text()).toBe("正在思考…");
  });

  it("回合结束：Thinking 块完整保留、可展开回看，进行中指示消失", async () => {
    const wrapper = mount(ChatView, {
      props: { agentId: "a1" },
    });
    await flushPromises();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const push = (frame: unknown) => ws.onmessage?.({ data: JSON.stringify(frame) });

    push({ type: "thinking.delta", delta: "想" });
    push({ type: "thinking.delta", delta: "清楚" });
    push({ type: "turn.end" });
    await flushPromises();

    const details = wrapper.find(".thinking-block");
    expect(details.exists()).toBe(true);
    expect(wrapper.find(".thinking-body").text()).toBe("想清楚");
    expect(wrapper.find(".thinking-hint").exists()).toBe(false);
    expect(details.attributes("open")).toBeUndefined();

    await wrapper.find(".thinking-summary").trigger("click");
    expect(details.attributes("open")).toBeDefined();
  });

  it("无 thinking 帧的回合不显示 Thinking 区", async () => {
    const wrapper = mount(ChatView, {
      props: { agentId: "a1" },
    });
    await flushPromises();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const push = (frame: unknown) => ws.onmessage?.({ data: JSON.stringify(frame) });

    push({ type: "text.delta", delta: "你好" });
    push({ type: "turn.end" });
    await flushPromises();

    expect(wrapper.find(".thinking-block").exists()).toBe(false);
    expect(wrapper.find(".message-text").text()).toBe("你好");
  });

  it("换班续跑横幅：running 期间输入框可打断（发送消息清横幅）", async () => {
    const wrapper = mount(ChatView, {
      props: { agentId: "a1" },
    });
    await flushPromises();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const push = (frame: unknown) => ws.onmessage?.({ data: JSON.stringify(frame) });

    // 续跑中流式输出 + 换班状态帧
    push({ type: "text.delta", delta: "续跑进展" });
    push({ type: "handoff.update", status: "running", shift: 2, maxShifts: 3 });
    await flushPromises();

    const banner = wrapper.find(".handoff-banner");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("第 2/3 棒");
    expect(banner.text()).toContain("发送消息可打断");
    await wrapper.find(".message-input input").setValue("打断");
    // 换班续跑中不锁输入框：有文本且发送按钮可用（用户消息 = abort 打断）
    expect(wrapper.find(".message-input button").attributes("disabled")).toBeUndefined();
    await wrapper.find(".message-input input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(wrapper.find(".handoff-banner").exists()).toBe(false);
  });

  it("棒数保险丝撞顶：横幅展示停止续跑", async () => {
    const wrapper = mount(ChatView, {
      props: { agentId: "a1" },
    });
    await flushPromises();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    ws.onmessage?.({
      data: JSON.stringify({ type: "handoff.update", status: "fused", shift: 3, maxShifts: 3 }),
    });
    await flushPromises();
    expect(wrapper.find(".handoff-banner").text()).toContain("已达棒数上限，自动续跑停止");
  });
});


describe("ChatView 加载更早入口（F3）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MockWebSocket.instances.forEach((ws) => ws.close());
  });

  // 服务端满页截断语义的 mock：before 游标（消息 id，不含本身）之前最近 limit 条
  function stubHistoryServer(count: number) {
    const all = Array.from({ length: count }, (_, i) => ({
      id: `m${i + 1}`,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `第 ${i + 1} 条` }],
      createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    }));
    const urls: string[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      let body: unknown = [];
      if (url.includes("/chat/")) {
        const u = new URL(url);
        const limit = Number(u.searchParams.get("limit") ?? "100");
        const before = u.searchParams.get("before");
        let list = all;
        if (before) {
          const idx = all.findIndex((r) => r.id === before);
          if (idx >= 0) list = all.slice(0, idx);
        }
        body = list.slice(-limit);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response);
    }) as unknown as typeof fetch;
    return urls;
  }

  it("满页首载显示「加载更早」，点击前置更早历史，短页后变「没有更早的消息了」", async () => {
    const urls = stubHistoryServer(120);
    const wrapper = mount(ChatView, { props: { agentId: "a1" } });
    await flushPromises();

    // 首载最新 100 条（m21..m120），满页 → 入口可点
    expect(wrapper.findAll(".message-bubble")).toHaveLength(100);
    const btn = wrapper.find("button.load-older");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toBe("加载更早");

    await btn.trigger("click");
    await flushPromises();

    // 游标为首载最早一条 m21；更早的 m1..m20 前置到列表头部
    expect(urls.some((u) => u.includes("before=m21"))).toBe(true);
    const bubbles = wrapper.findAll(".message-bubble");
    expect(bubbles).toHaveLength(120);
    expect(bubbles[0]!.text()).toContain("第 1 条");
    // 短页收口：按钮消失，显示「没有更早」
    expect(wrapper.find("button.load-older").exists()).toBe(false);
    expect(wrapper.find(".load-older.done").text()).toBe("没有更早的消息了");
  });

  it("短历史（不满一页）无加载入口，直接显示「没有更早的消息了」", async () => {
    stubHistoryServer(3);
    const wrapper = mount(ChatView, { props: { agentId: "a1" } });
    await flushPromises();
    expect(wrapper.find("button.load-older").exists()).toBe(false);
    expect(wrapper.find(".load-older.done").text()).toBe("没有更早的消息了");
  });

  it("空历史不显示翻页文案，保持空态", async () => {
    stubHistoryServer(0);
    const wrapper = mount(ChatView, { props: { agentId: "a1" } });
    await flushPromises();
    expect(wrapper.find("button.load-older").exists()).toBe(false);
    expect(wrapper.find(".load-older.done").exists()).toBe(false);
    expect(wrapper.find(".empty").text()).toBe("暂无消息，开始对话吧");
  });
});

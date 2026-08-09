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

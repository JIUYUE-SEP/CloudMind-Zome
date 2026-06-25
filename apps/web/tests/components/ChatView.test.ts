import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import ChatView from "../../components/ChatView.vue";

class MockWebSocket {
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

  send() {}
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
});

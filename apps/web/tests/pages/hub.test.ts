import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import Hub from "../../pages/hub.vue";

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sent.push(data);
    return true;
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const groupSession = {
  id: "s1",
  name: "Team",
  agentIds: ["a1"],
  type: "group" as const,
  createdAt: "",
  updatedAt: "",
};

function mockFetch(url: string) {
  if (url.includes("/agents")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([{ id: "a1", name: "Alice", persona: "", skills: [], tools: [] }]),
    } as unknown as Response);
  }
  if (url.includes("/sessions") && !url.includes("/messages")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([groupSession]),
    } as unknown as Response);
  }
  if (url.includes("/sessions/s1/messages")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    } as unknown as Response);
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
}

describe("Hub page group chat", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    globalThis.fetch = vi.fn(mockFetch) as unknown as typeof globalThis.fetch;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MockWebSocket.instances.forEach((ws) => ws.close());
  });

  async function mountHub() {
    return mount(Hub, {
      global: {
        stubs: {
          GroupChatView: {
            name: "GroupChatView",
            template: "<div class='group-chat-view'></div>",
          },
        },
      },
    });
  }

  it("快速切换群聊时，先选会话的迟到历史不覆盖后选会话", async () => {
    const s2 = { ...groupSession, id: "s2", name: "Team2" };
    const record = (id: string, text: string) => ({
      id,
      role: "assistant",
      content: [{ type: "text", text }],
      createdAt: "",
    });
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/sessions/s1/messages")) {
        // s1 的历史慢返回：切到 s2 之后才 resolve
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: () => Promise.resolve([record("old-s1", "S1 历史")]),
              } as unknown as Response),
            40,
          ),
        );
      }
      if (url.includes("/sessions/s2/messages")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([record("new-s2", "S2 历史")]),
        } as unknown as Response);
      }
      if (url.includes("/sessions") && !url.includes("/messages")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([groupSession, s2]),
        } as unknown as Response);
      }
      return mockFetch(url);
    }) as unknown as typeof globalThis.fetch;

    const wrapper = await mountHub();
    await flushPromises();
    const groupTab = wrapper.findAll(".comm-mode-btn").find((el) => el.text() === "群聊");
    await groupTab!.trigger("click");
    await flushPromises();

    // 先选 s1（历史加载在途），立刻改选 s2
    const items = wrapper.findAll(".comm-item");
    await items.find((el) => el.text().includes("Team"))!.trigger("click");
    await items.find((el) => el.text().includes("Team2"))!.trigger("click");

    // 等 s1 的慢响应也返回后断言：消息列表只有 s2 的历史
    await new Promise((r) => setTimeout(r, 80));
    await flushPromises();

    const msgs = (wrapper.vm as unknown as { groupMessages: { id: string; text: string }[] })
      .groupMessages;
    expect(msgs.map((m) => m.id)).toEqual(["new-s2"]);
  });

  it("群聊历史加载在途时卸载组件：迟到响应不再建立连接（M41 alive 门）", async () => {
    let resolveMessages!: (value: unknown) => void;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/sessions/s1/messages")) {
        // 历史加载挂起：组件卸载后才 resolve
        return new Promise((resolve) => {
          resolveMessages = resolve;
        });
      }
      return mockFetch(url);
    }) as unknown as typeof globalThis.fetch;

    const wrapper = await mountHub();
    await flushPromises();
    const groupTab = wrapper.findAll(".comm-mode-btn").find((el) => el.text() === "群聊");
    await groupTab!.trigger("click");
    await flushPromises();
    await wrapper.findAll(".comm-item").find((el) => el.text().includes("Team"))!.trigger("click");
    await flushPromises();

    // 历史加载仍在途时卸载：await 返回后不得 connectGroup（迟到建连会常驻泄漏）
    wrapper.unmount();
    resolveMessages({ ok: true, json: () => Promise.resolve([]) });
    await flushPromises();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("群聊断线时 pending 审批卡片标为 expired（M44 断线即失效）", async () => {
    const wrapper = await mountHub();
    await flushPromises();
    const groupTab = wrapper.findAll(".comm-mode-btn").find((el) => el.text() === "群聊");
    await groupTab!.trigger("click");
    await flushPromises();
    await wrapper.findAll(".comm-item").find((el) => el.text().includes("Team"))!.trigger("click");
    await flushPromises();

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const vm = wrapper.vm as unknown as { groupMessages: { approval?: { status: string } }[] };
    ws.onmessage?.({
      data: JSON.stringify({
        type: "tool.approval_request",
        approvalId: "ap1",
        toolCallId: "t1",
        toolName: "run_command",
        arguments: { command: "rm -rf /tmp/x" },
      }),
    });
    expect(vm.groupMessages.at(-1)!.approval?.status).toBe("pending");

    // 无关闭码 = 异常断开 → onReconnecting：engine 侧 pending 审批已随连接按拒绝收尾
    ws.onclose?.();
    expect(vm.groupMessages.at(-1)!.approval?.status).toBe("expired");

    wrapper.unmount();
  });
});

describe("Hub page private chat switching（#6 切会话消息丢失）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MockWebSocket.instances.forEach((ws) => ws.close());
  });

  function record(id: string, text: string) {
    return {
      id,
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      createdAt: "2026-07-21T00:00:00.000Z",
    };
  }

  it("与 A 聊完切到 B 再切回 A：A 的消息列表不丢（旧 ChatView 迟到卸载不清新会话）", async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/agents")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: "a", name: "Alice", persona: "", skills: [], tools: [] },
              { id: "b", name: "Bob", persona: "", skills: [], tools: [] },
            ]),
        } as unknown as Response);
      }
      if (url.includes("/chat/a/messages")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([record("m-a", "A 的历史")]),
        } as unknown as Response);
      }
      if (url.includes("/chat/b/messages")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([record("m-b", "B 的历史")]),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
    }) as unknown as typeof globalThis.fetch;

    const wrapper = mount(Hub);
    await flushPromises();

    const items = () => wrapper.findAll(".comm-item");
    await items().find((el) => el.text().includes("Alice"))!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("A 的历史");

    await items().find((el) => el.text().includes("Bob"))!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("B 的历史");

    await items().find((el) => el.text().includes("Alice"))!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("A 的历史");
    expect(wrapper.text()).not.toContain("B 的历史");
  });
});

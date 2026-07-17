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

describe("Hub page group chat code mode", () => {
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

  async function selectGroup(wrapper: ReturnType<typeof mount>) {
    await flushPromises();
    const groupTab = wrapper.findAll(".comm-mode-btn").find((el) => el.text() === "群聊");
    expect(groupTab?.exists()).toBe(true);
    await groupTab!.trigger("click");
    await flushPromises();

    const item = wrapper.findAll(".comm-item").find((el) => el.text().includes("Team"));
    expect(item?.exists()).toBe(true);
    await item!.trigger("click");
    await flushPromises();
  }

  function currentWs() {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

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

  it("renders chat/code mode switch after selecting a group session", async () => {
    const wrapper = await mountHub();
    await selectGroup(wrapper);
    expect(wrapper.find(".group-mode-switch").exists()).toBe(true);
    const buttons = wrapper.findAll(".group-mode-switch button");
    expect(buttons.length).toBe(2);
    expect(buttons[0].text()).toBe("聊天");
    expect(buttons[1].text()).toBe("编程");
  });

  it("sends session.set_mode frame when switching to code mode", async () => {
    const wrapper = await mountHub();
    await selectGroup(wrapper);
    const codeBtn = wrapper.findAll(".group-mode-switch button")[1];
    await codeBtn.trigger("click");
    await flushPromises();

    const ws = currentWs();
    const last = ws.sent[ws.sent.length - 1];
    expect(JSON.parse(last)).toEqual({
      type: "session.set_mode",
      mode: "code",
      projectId: "s1",
    });
    expect((wrapper.vm as unknown as { sessionMode: string }).sessionMode).toBe("code");
  });

  it("updates state on session.mode_changed", async () => {
    const wrapper = await mountHub();
    await selectGroup(wrapper);
    const ws = currentWs();

    ws.onmessage?.({
      data: JSON.stringify({ type: "session.mode_changed", mode: "code", projectId: "s1" }),
    });
    await flushPromises();

    expect((wrapper.vm as unknown as { sessionMode: string }).sessionMode).toBe("code");
    expect(
      (wrapper.vm as unknown as { sessionProjectId?: string }).sessionProjectId,
    ).toBe("s1");
  });
});

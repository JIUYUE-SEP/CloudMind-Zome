import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import Hub from "../../pages/hub.vue";
import { useUiModeStore } from "../../stores/ui-mode";

const AGENTS = [
  { id: "a1", name: "Alice", codename: "", persona: "", skills: [], tools: [] },
  { id: "a2", name: "Beta", codename: "", persona: "", skills: [], tools: [] },
];
const GROUP_SESSION = { id: "s1", name: "Team", agentIds: ["a1"], type: "group", createdAt: "", updatedAt: "" };

function mockFetch(agentList = AGENTS) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (data: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);
    if (url.includes("/agents")) return json(agentList);
    if (url.includes("/sessions") && !url.includes("/messages")) return json([GROUP_SESSION]);
    return json([]);
  });
}

describe("hub 单/多模式（web 纯呈现层，决策 1-3）", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.stubGlobal("fetch", mockFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("缺省恒等 multi：私聊/群聊 tabs 与双列表逐字节现状", async () => {
    const wrapper = mount(Hub);
    await flushPromises();

    const uiMode = useUiModeStore();
    expect(uiMode.agentMode).toBe("multi");
    // 现状结构：tabs、agent 列表、群聊入口全部在场；单模式选择器不在场
    expect(wrapper.text()).toContain("私聊");
    expect(wrapper.text()).toContain("群聊");
    expect(wrapper.text()).toContain("Alice");
    expect(wrapper.find(".single-agent-select").exists()).toBe(false);
    // 切到群聊 tab：群聊会话与创建入口在
    const groupTab = wrapper.findAll(".comm-mode-switch .comm-mode-btn").find((b) => b.text() === "群聊");
    await groupTab!.trigger("click");
    expect(wrapper.text()).toContain("Team");
    expect(wrapper.text()).toContain("创建群聊");
  });

  it("切单模式：tabs/双列表收敛，顶栏选择器出现并直达私聊", async () => {
    const wrapper = mount(Hub);
    await flushPromises();

    const uiMode = useUiModeStore();
    uiMode.selectAgent("a1");
    await flushPromises();

    // 收敛：私聊/群聊 tabs、agent 列表、群聊入口全部消失
    expect(wrapper.findAll(".comm-mode-switch .comm-mode-btn").map((b) => b.text())).not.toContain("群聊");
    expect(wrapper.text()).not.toContain("创建群聊");
    expect(wrapper.find(".comm-item").exists()).toBe(false);
    // 选择器出现且直达 a1 私聊（ChatView 渲染）
    const select = wrapper.find(".single-agent-select");
    expect(select.exists()).toBe(true);
    expect((select.element as HTMLSelectElement).value).toBe("a1");
    expect(wrapper.findComponent({ name: "ChatView" }).exists()).toBe(true);
    // 持久化
    expect(localStorage.getItem("cloudmind.agentMode")).toBe("single");
    expect(localStorage.getItem("cloudmind.singleAgentId")).toBe("a1");
  });

  it("选择器切换：singleAgentId 更新且私聊直达目标换人", async () => {
    const wrapper = mount(Hub);
    await flushPromises();

    const uiMode = useUiModeStore();
    uiMode.selectAgent("a1");
    await flushPromises();

    const select = wrapper.find(".single-agent-select");
    await select.setValue("a2");
    await flushPromises();

    expect(uiMode.singleAgentId).toBe("a2");
    expect(localStorage.getItem("cloudmind.singleAgentId")).toBe("a2");
    const chatView = wrapper.findComponent({ name: "ChatView" });
    expect(chatView.props("agentId")).toBe("a2");
  });

  it("选中 agent 被删：自动回退 multi + 页面内提示", async () => {
    const wrapper = mount(Hub);
    await flushPromises();

    const uiMode = useUiModeStore();
    uiMode.selectAgent("a1");
    await flushPromises();
    expect(wrapper.find(".single-agent-select").exists()).toBe(true);

    // 模拟 agent 被删：名录重拉不再含 a1
    vi.stubGlobal("fetch", mockFetch([AGENTS[1]!]));
    const agentsStore = (await import("../../stores/agents")).useAgentsStore();
    await agentsStore.load();
    await flushPromises();

    expect(uiMode.agentMode).toBe("multi");
    expect(uiMode.singleAgentId).toBe("");
    expect(wrapper.text()).toContain("已被删除");
    // 回退后恢复多模式结构
    expect(wrapper.find(".single-agent-select").exists()).toBe(false);
    expect(wrapper.text()).toContain("群聊");
  });

  it("单模式未选 agent：保持单模式，落选择器聚焦提示", async () => {
    const wrapper = mount(Hub);
    await flushPromises();

    const uiMode = useUiModeStore();
    uiMode.setMode("single");
    await flushPromises();

    expect(uiMode.agentMode).toBe("single");
    expect((wrapper.find(".single-agent-select").element as HTMLSelectElement).value).toBe("");
    expect(wrapper.text()).toContain("在上方选择一位心智，直达私聊");
  });

  it("冷启动回归（review High）：预置 single 态刷新——名录在途不误判抹盘，到达后保持 single 直达私聊", async () => {
    // 预置 localStorage（模拟上次退出时的 single 状态）
    localStorage.setItem("cloudmind.agentMode", "single");
    localStorage.setItem("cloudmind.singleAgentId", "a1");
    setActivePinia(createPinia());

    // /agents 延迟可控：名录到达前 mount 已完成（watch immediate 首跑现场）
    let resolveAgents: ((v: unknown) => void) | undefined;
    const agentsPending = new Promise((r) => {
      resolveAgents = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const json = (data: unknown) =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);
        if (url.includes("/agents")) return agentsPending;
        if (url.includes("/sessions") && !url.includes("/messages")) return json([GROUP_SESSION]);
        return json([]);
      }),
    );

    const wrapper = mount(Hub);
    await flushPromises();

    // 名录在途：不得误判"已删除"——single 保持、无提示、不抹盘、不提前开聊
    const uiMode = useUiModeStore();
    expect(uiMode.agentMode).toBe("single");
    expect(uiMode.notice).toBe("");
    expect(localStorage.getItem("cloudmind.agentMode")).toBe("single");
    expect(localStorage.getItem("cloudmind.singleAgentId")).toBe("a1");
    expect(wrapper.findComponent({ name: "ChatView" }).exists()).toBe(false);

    // 名录到达（含 a1）：保持 single、无提示、不抹盘、直达 a1 私聊
    // （生产真形状：Response 对象，不是裸数组——ensureOk 要过 ok 闸）
    resolveAgents!({ ok: true, status: 200, json: () => Promise.resolve(AGENTS) });
    await flushPromises();

    expect(uiMode.agentMode).toBe("single");
    expect(uiMode.singleAgentId).toBe("a1");
    expect(uiMode.notice).toBe("");
    expect(localStorage.getItem("cloudmind.agentMode")).toBe("single");
    expect(localStorage.getItem("cloudmind.singleAgentId")).toBe("a1");
    const chatView = wrapper.findComponent({ name: "ChatView" });
    expect(chatView.exists()).toBe(true);
    expect(chatView.props("agentId")).toBe("a1");
  });
});

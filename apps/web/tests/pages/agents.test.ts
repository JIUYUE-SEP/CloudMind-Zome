import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import type { AgentConfig } from "@mindcloud/shared";
import AgentsIndex from "../../pages/agents/index.vue";
import AgentsNew from "../../pages/agents/new.vue";
import AgentEdit from "../../pages/agents/[id]/edit.vue";

const { navigateToMock, routerPushMock, routeParams } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  routerPushMock: vi.fn(),
  routeParams: { id: "" as string },
}));

mockNuxtImport("navigateTo", () => navigateToMock);
mockNuxtImport("useRoute", () => () => ({ params: routeParams }));
mockNuxtImport("useRouter", () => () => ({
  push: routerPushMock,
  options: { history: { state: { back: null } } },
}));

const agentA: AgentConfig = {
  id: "a1",
  name: "Alice",
  description: "测试助手",
  persona: "",
  skills: ["s1"],
  tools: ["t1", "t2"],
  tags: ["助手"],
  providerId: "deepseek",
  modelId: "v4-flash",
};

function json(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as unknown as Response);
}

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

/** 以 /agents REST 语义模拟后端，返回 fetch 与调用记录 */
function mockAgentsFetch(list: AgentConfig[]) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.endsWith("/agents") && method === "GET") return json(list);
    if (url.endsWith("/agents") && method === "POST") return json(body);
    if (/\/agents\/[^/]+$/.test(url) && method === "PUT") return json(body);
    if (/\/agents\/[^/]+$/.test(url) && method === "DELETE") return json({});
    // 其余接口（compute/providers、config/tools 等）默认返回空列表
    return json([]);
  });
  return { fetchMock, calls };
}

function mountOptions() {
  return { global: { stubs: { NuxtLink: true } } };
}

describe("agents 列表页", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    navigateToMock.mockClear();
    routerPushMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("空状态显示创建引导", async () => {
    const { fetchMock } = mockAgentsFetch([]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(AgentsIndex, mountOptions());
    await flushPromises();

    expect(wrapper.text()).toContain("还没有心智");
    expect(wrapper.text()).toContain("新建心智");
    expect(wrapper.find(".agent-grid").exists()).toBe(false);
  });

  it("有数据时渲染 Agent 卡片（名称/描述/标签/模型/工具技能数）", async () => {
    const { fetchMock } = mockAgentsFetch([agentA]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(AgentsIndex, mountOptions());
    await flushPromises();

    const cards = wrapper.findAll(".agent-card");
    expect(cards).toHaveLength(1);
    const text = cards[0].text();
    expect(text).toContain("Alice");
    expect(text).toContain("a1");
    expect(text).toContain("测试助手");
    expect(text).toContain("deepseek/v4-flash");
    expect(text).toContain("助手");
    expect(text).toContain("2 工具");
    expect(text).toContain("1 技能");
  });

  it("点击卡片与编辑按钮都进入编辑页", async () => {
    const { fetchMock } = mockAgentsFetch([agentA]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(AgentsIndex, mountOptions());
    await flushPromises();

    await wrapper.find(".agent-card").trigger("click");
    expect(navigateToMock).toHaveBeenCalledWith("/agents/a1/edit");

    navigateToMock.mockClear();
    const editBtn = wrapper
      .findAll(".card-actions button")
      .find((b) => b.text() === "编辑");
    await editBtn!.trigger("click");
    expect(navigateToMock).toHaveBeenCalledWith("/agents/a1/edit");
  });

  it("删除需确认：取消不删，确认后调用 DELETE 并移除卡片", async () => {
    const { fetchMock, calls } = mockAgentsFetch([agentA]);
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);

    const wrapper = mount(AgentsIndex, mountOptions());
    await flushPromises();

    const deleteBtn = () =>
      wrapper.findAll(".card-actions button").find((b) => b.text() === "删除");

    // 取消确认：不发起删除
    await deleteBtn()!.trigger("click");
    await flushPromises();
    expect(confirmMock).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(wrapper.find(".agent-card").exists()).toBe(true);

    // 确认删除：调用 DELETE，卡片消失回到空状态
    confirmMock.mockReturnValue(true);
    await deleteBtn()!.trigger("click");
    await flushPromises();
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/agents/a1");
    expect(wrapper.find(".agent-card").exists()).toBe(false);
    expect(wrapper.text()).toContain("还没有心智");
  });
});

describe("agents 新建页", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    navigateToMock.mockClear();
    routeParams.id = "";
  });

  it("表单空白，保存成功后跳转编辑页", async () => {
    const { fetchMock, calls } = mockAgentsFetch([]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(AgentsNew);
    await flushPromises();

    expect(wrapper.text()).toContain("新建心智");
    const inputs = wrapper.findAll(".form-section input");
    expect((inputs[0].element as HTMLInputElement).value).toBe("");

    await inputs[0].setValue("new-agent");
    await inputs[1].setValue("新心智");
    await wrapper.find(".save-btn").trigger("click");
    await flushPromises();

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toMatch(/\/agents$/);
    expect(post?.body).toMatchObject({ id: "new-agent", name: "新心智" });
    expect(navigateToMock).toHaveBeenCalledWith("/agents/new-agent/edit");
  });

  it("缺少 ID 或名称时提示且不提交", async () => {
    const { fetchMock, calls } = mockAgentsFetch([]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(AgentsNew);
    await flushPromises();

    await wrapper.find(".save-btn").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("请填写 ID 和名称后再保存");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("agents 编辑页", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    navigateToMock.mockClear();
    routerPushMock.mockClear();
    routeParams.id = "a1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("自动加载现有 Agent 数据，保存时提交更新", async () => {
    const { fetchMock, calls } = mockAgentsFetch([agentA]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(AgentEdit);
    await flushPromises();

    expect(wrapper.text()).toContain("编辑心智");
    expect(wrapper.find(".agent-id-badge").text()).toBe("a1");

    const nameInput = wrapper.findAll(".form-section input")[1];
    expect((nameInput.element as HTMLInputElement).value).toBe("Alice");

    await nameInput.setValue("Alice2");
    await wrapper.find(".save-btn").trigger("click");
    await flushPromises();

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/agents/a1");
    expect(put?.body).toMatchObject({ id: "a1", name: "Alice2" });
    // 编辑保存停留在当前页，不跳转
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it("返回按钮回到列表页", async () => {
    const { fetchMock } = mockAgentsFetch([agentA]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(AgentEdit);
    await flushPromises();

    await wrapper.find(".back-btn").trigger("click");
    expect(routerPushMock).toHaveBeenCalledWith("/agents");
  });

  it("删除确认后调用 DELETE 并返回列表", async () => {
    const { fetchMock, calls } = mockAgentsFetch([agentA]);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    const wrapper = mount(AgentEdit);
    await flushPromises();

    await wrapper.find(".danger-btn").trigger("click");
    await flushPromises();

    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/agents/a1");
    expect(navigateToMock).toHaveBeenCalledWith("/agents");
  });

  it("ID 不存在时显示未找到", async () => {
    const { fetchMock } = mockAgentsFetch([]);
    vi.stubGlobal("fetch", fetchMock);

    routeParams.id = "ghost";
    const wrapper = mount(AgentEdit);
    await flushPromises();

    expect(wrapper.text()).toContain("未找到该心智");
    expect(wrapper.find(".form-section").exists()).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import SessionsPage from "../../pages/sessions/index.vue";

const sessionA = {
  id: "s1",
  name: "Team A",
  agentIds: ["a1", "a2"],
  type: "group" as const,
  createdAt: "",
  updatedAt: "",
};
const sessionB = {
  id: "s2",
  name: "Team B",
  agentIds: ["a1"],
  type: "group" as const,
  createdAt: "",
  updatedAt: "",
};

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

// NuxtLink 打桩为朴素锚点（与 tests/layouts/default.test.ts 同式），聚焦行内交互本身
const NuxtLinkStub = {
  name: "NuxtLink",
  props: ["to"],
  template: '<a :href="to"><slot /></a>',
};

function mockFetch(options?: { putFails?: boolean; deleteFails?: boolean }) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    const json = (data: unknown, ok = true, status = 200) =>
      Promise.resolve({ ok, status, json: () => Promise.resolve(data) } as unknown as Response);

    if (url.endsWith("/agents")) return json([]);
    if (url.endsWith("/sessions/s1") && method === "PUT") {
      // 404 口径：engine 失败响应携带 { error } 正文，ensureOk 透出
      if (options?.putFails) return json({ error: "session not found" }, false, 404);
      return json({ ...sessionA, ...body });
    }
    if (url.endsWith("/sessions/s1") && method === "DELETE") {
      if (options?.deleteFails) return json({ error: "session not found" }, false, 404);
      return json({ ok: true });
    }
    if (url.endsWith("/sessions") && method === "GET") return json([sessionA, sessionB]);
    return json({});
  });
  return { fetchMock, calls };
}

async function mountPage() {
  const wrapper = mount(SessionsPage, { global: { stubs: { NuxtLink: NuxtLinkStub } } });
  await flushPromises();
  return wrapper;
}

/** 按群聊名找到所在行 */
function findRow(wrapper: ReturnType<typeof mount>, name: string) {
  const row = wrapper.findAll(".session-list li").find((li) => li.text().includes(name));
  expect(row).toBeTruthy();
  return row!;
}

describe("群聊会话列表：重命名与删除", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("重命名成功：PUT 只传 name，列表同步新名称", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    const row = findRow(wrapper, "Team A");
    await row.findAll("button").find((b) => b.text() === "重命名")!.trigger("click");
    await row.find("input").setValue("Team A+");
    await row.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    await flushPromises();

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/sessions/s1");
    expect(put?.body).toEqual({ name: "Team A+" });
    expect(wrapper.text()).toContain("Team A+");
    // 成功后退出编辑态
    expect(wrapper.find(".session-list input").exists()).toBe(false);
  });

  it("重命名 404：错误透出，编辑态保持，列表不变", async () => {
    const { fetchMock } = mockFetch({ putFails: true });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    const row = findRow(wrapper, "Team A");
    await row.findAll("button").find((b) => b.text() === "重命名")!.trigger("click");
    await row.find("input").setValue("Team A+");
    await row.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("session not found");
    // 编辑态保持，输入框保留用户编辑值
    const input = wrapper.find(".session-list input");
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe("Team A+");
    // 列表未被脏写：store 中名称仍是旧值
    const { useSessionsStore } = await import("@/stores/sessions");
    expect(useSessionsStore().sessions.find((s) => s.id === "s1")?.name).toBe("Team A");
  });

  it("名称未变时保存不发 PUT", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    const row = findRow(wrapper, "Team A");
    await row.findAll("button").find((b) => b.text() === "重命名")!.trigger("click");
    await row.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    await flushPromises();

    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(wrapper.find(".session-list input").exists()).toBe(false);
  });

  it("删除：确认后 DELETE，列表移除该群聊", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const wrapper = await mountPage();

    const row = findRow(wrapper, "Team A");
    await row.findAll("button").find((b) => b.text() === "删除")!.trigger("click");
    await flushPromises();

    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/sessions/s1");
    expect(wrapper.text()).not.toContain("Team A");
    // 另一行不受影响
    expect(wrapper.text()).toContain("Team B");
  });

  it("删除：确认框取消则不发 DELETE", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => false));
    const wrapper = await mountPage();

    const row = findRow(wrapper, "Team A");
    await row.findAll("button").find((b) => b.text() === "删除")!.trigger("click");
    await flushPromises();

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(wrapper.text()).toContain("Team A");
  });

  it("删除 404：错误透出，列表保留该行", async () => {
    const { fetchMock } = mockFetch({ deleteFails: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const wrapper = await mountPage();

    const row = findRow(wrapper, "Team A");
    await row.findAll("button").find((b) => b.text() === "删除")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("session not found");
    expect(wrapper.text()).toContain("Team A");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import Scheduler from "../../pages/scheduler.vue";

const agentA = { id: "a1", name: "Alice", persona: "", skills: [], tools: [] };

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

function mockFetch() {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.endsWith("/agents") && method === "GET") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([agentA]) } as unknown as Response);
    }
    if (url.includes("/scheduler/") && method === "GET") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
    }
    if (url.includes("/scheduler/") && method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "t1", agentId: "a1", ...body }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
  });
  return { fetchMock, calls };
}

async function mountAndSelectAgent() {
  const wrapper = mount(Scheduler);
  await flushPromises();
  const select = wrapper.find("select");
  await select.setValue("a1");
  await flushPromises();
  return wrapper;
}

describe("scheduler 定时任务页", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("非法 cron 被前端预校验拦截，不提交后端", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await mountAndSelectAgent();
    await wrapper.find("input[required]").setValue("每天提醒");
    await wrapper.find("input[placeholder='0 9 * * *']").setValue("每天一次");
    await wrapper.find("textarea").setValue("提醒我喝水");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("Cron 表达式需为 5 段格式");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("合法 cron 正常提交", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await mountAndSelectAgent();
    await wrapper.find("input[required]").setValue("每天提醒");
    await wrapper.find("input[placeholder='0 9 * * *']").setValue("  0 9 * * *  ");
    await wrapper.find("textarea").setValue("提醒我喝水");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/scheduler/a1");
    expect(post?.body).toMatchObject({ description: "每天提醒", cron: "0 9 * * *" });
    expect(wrapper.text()).not.toContain("Cron 表达式需为 5 段格式");
  });
});

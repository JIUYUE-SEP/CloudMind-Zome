import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import ComputeIndex from "../../../pages/compute/index.vue";
import type { Provider } from "@/composables/useEngineClient";

const { navigateToMock, routerPushMock } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  routerPushMock: vi.fn(),
}));

mockNuxtImport("navigateTo", () => navigateToMock);
mockNuxtImport("useRouter", () => () => ({ push: routerPushMock }));

const nuxtLinkStub = {
  name: "NuxtLink",
  props: ["to"],
  template: `<a class="nuxt-link-stub" :href="to"><slot /></a>`,
};

function mountIndex(options: Parameters<typeof mount>[1] = {}) {
  return mount(ComputeIndex, {
    ...options,
    global: {
      ...options.global,
      stubs: { NuxtLink: nuxtLinkStub, ...options.global?.stubs },
    },
  });
}

const provider: Provider = {
  id: "p1",
  displayName: "OpenAI",
  providerType: "openai",
  baseUrl: "https://api.openai.com/v1",
  models: [],
};

interface FetchCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

function mockFetch(
  handler?: (call: { url: string; method: string; body?: Record<string, unknown> }) => Promise<Response> | Response,
  providers: Provider[] = [provider],
) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (handler && url.includes("/test")) {
      return handler({ url, method, body });
    }
    if (url.endsWith("/compute/providers") && method === "GET") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(providers) } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetchMock, calls };
}

function testButton(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper.findAll("button").find((b) => b.text().includes("测试"));
  expect(btn).toBeTruthy();
  return btn!;
}

async function openAddModal(wrapper: ReturnType<typeof mount>) {
  const addBtn = wrapper.findAll("button").find((b) => b.text().includes("添加 Provider"));
  expect(addBtn).toBeTruthy();
  await addBtn!.trigger("click");
  await flushPromises();
}

async function openEditModal(wrapper: ReturnType<typeof mount>) {
  const editBtn = wrapper.findAll(".provider-card button").find((b) => b.text().includes("编辑"));
  expect(editBtn).toBeTruthy();
  await editBtn!.trigger("click");
  await flushPromises();
}

describe("compute 列表页：测试连接反馈", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    navigateToMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("测试进行中显示 loading 且按钮禁用，成功后显示连接成功", async () => {
    let resolveTest: ((r: unknown) => void) | undefined;
    const { fetchMock } = mockFetch(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve as unknown as (r: unknown) => void;
        }) as Promise<Response>,
    );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountIndex();
    await flushPromises();

    const btn = testButton(wrapper);
    expect(btn.text()).toBe("测试连接");
    await btn.trigger("click");

    // 进行中：按钮文案变化且禁用
    expect(testButton(wrapper).text()).toBe("测试中...");
    expect(testButton(wrapper).attributes("disabled")).toBeDefined();

    resolveTest!({
      ok: true,
      json: () =>
        Promise.resolve({ ok: true, discovered: [{ id: "gpt-5", displayName: "gpt-5", modelType: "llm" }] }),
    });
    await flushPromises();

    const result = wrapper.find(".test-result");
    expect(result.text()).toContain("连接成功");
    expect(result.text()).toContain("发现 1 个型号");
    expect(result.text()).toContain("进入管理页导入");
    // 列表页仅做快速健康检查，导入区已迁到管理页
    expect(wrapper.find(".discovered-import").exists()).toBe(false);
    expect(wrapper.find(".import-link").attributes("href")).toBe("/compute/p1");
    expect(testButton(wrapper).text()).toBe("测试连接");
    expect(testButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("测试成功结果带发现数量与进入管理页导入链接", async () => {
    const { fetchMock } = mockFetch(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            discovered: [
              { id: "gpt-4o", displayName: "gpt-4o", modelType: "llm" },
              { id: "gpt-5", displayName: "gpt-5", modelType: "llm" },
              { id: "claude-3-5-sonnet", displayName: "claude-3-5-sonnet", modelType: "llm" },
            ],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountIndex();
    await flushPromises();

    await testButton(wrapper).trigger("click");
    await flushPromises();

    const result = wrapper.find(".test-result");
    expect(result.text()).toContain("连接成功");
    expect(result.text()).toContain("发现 3 个型号");
    expect(result.text()).toContain("进入管理页导入");
    expect(wrapper.find(".import-link").attributes("href")).toBe("/compute/p1");
  });

  it("测试失败显示错误信息并绑定到对应 Provider", async () => {
    const { fetchMock } = mockFetch(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: "Test connection failed" }),
      } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();

    await testButton(wrapper).trigger("click");
    await flushPromises();

    const result = wrapper.find(".test-result");
    expect(result.classes()).toContain("fail");
    expect(result.text()).toContain("连接失败");
    expect(result.text()).toContain("Test connection failed");
    // 结果渲染在该 Provider 卡片内
    expect(result.element.closest(".provider-card")?.textContent).toContain("OpenAI");
  });

  it("测试进行中再次点击不重复发起", async () => {
    let testCalls = 0;
    let resolveTest: ((r: unknown) => void) | undefined;
    const { fetchMock } = mockFetch(() => {
      testCalls++;
      return new Promise((resolve) => {
        resolveTest = resolve as unknown as (r: unknown) => void;
      }) as Promise<Response>;
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();

    await testButton(wrapper).trigger("click");
    await testButton(wrapper).trigger("click");
    expect(testCalls).toBe(1);

    resolveTest!({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await flushPromises();
  });
});

describe("compute 列表页：Provider 弹窗、路由与协议", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    navigateToMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("添加弹窗渲染 apiMode 选择器且缺省 chat_completions", async () => {
    const { fetchMock } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();
    await openAddModal(wrapper);

    const select = wrapper.find(".modal-content select");
    expect(select.exists()).toBe(true);
    expect(wrapper.findAll(".modal-content option").map((o) => o.text())).toEqual([
      "OpenAI 兼容 · 缺省",
      "OpenAI Responses",
      "Anthropic Messages",
    ]);
    expect((select.element as HTMLSelectElement).value).toBe("chat_completions");

    // 添加场景：API Key 占位符是必填提示
    const apiKeyInput = wrapper
      .findAll(".modal-content input")
      .find((i) => (i.element as HTMLInputElement).type === "password")!;
    expect((apiKeyInput.element as HTMLInputElement).placeholder).toBe("请输入 API Key");
  });

  it("编辑弹窗回显 apiMode（缺省 chat_completions）且占位符为留空保持", async () => {
    const { fetchMock } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();
    await openEditModal(wrapper);

    const select = wrapper.find(".modal-content select");
    expect((select.element as HTMLSelectElement).value).toBe("chat_completions");
    const apiKeyInput = wrapper
      .findAll(".modal-content input")
      .find((i) => (i.element as HTMLInputElement).type === "password")!;
    expect((apiKeyInput.element as HTMLInputElement).placeholder).toBe("留空则保持不变");
  });

  it("保存添加 Provider 提交 apiMode 且空 API Key 不落字段", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();
    await openAddModal(wrapper);

    const inputs = wrapper.findAll(".modal-content input");
    await inputs[0].setValue("DeepSeek");
    await inputs[1].setValue("https://api.deepseek.com");
    await wrapper.find(".modal-content select").setValue("anthropic");
    const saveBtn = wrapper.findAll("button").find((b) => b.text().includes("保存"));
    expect(saveBtn).toBeTruthy();
    await saveBtn!.trigger("click");
    await flushPromises();

    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/compute/providers"));
    expect(createCall).toBeTruthy();
    expect(createCall!.body).toMatchObject({
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      providerType: "openai",
      apiMode: "anthropic",
      models: [],
    });
    expect(createCall!.body).not.toHaveProperty("apiKey");
  });

  it("点击卡片跳转对应型号管理页", async () => {
    const { fetchMock } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();

    await wrapper.find(".provider-card").trigger("click");
    expect(navigateToMock).toHaveBeenCalledWith("/compute/p1");
    expect(wrapper.find(".modal-content").exists()).toBe(false);
  });

  it("特殊字符 Provider id 点击卡片跳到 encodeURIComponent 编码路径", async () => {
    const weirdProvider: Provider = { ...provider, id: "my/provider #1" };
    const { fetchMock } = mockFetch(undefined, [weirdProvider]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();

    await wrapper.find(".provider-card").trigger("click");
    expect(navigateToMock).toHaveBeenCalledWith("/compute/my%2Fprovider%20%231");
  });

  it("编辑按钮不触发卡片跳转（冒泡被阻止）", async () => {
    const { fetchMock } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();

    await openEditModal(wrapper);
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(wrapper.find(".modal-content").exists()).toBe(true);
  });

  it("Provider 卡片展示 apiMode 徽标与进入管理的 affordance", async () => {
    const responsesProvider: Provider = {
      ...provider,
      id: "p2",
      displayName: "Responses 源",
      apiMode: "responses",
    };
    const { fetchMock } = mockFetch(undefined, [provider, responsesProvider]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeIndex);
    await flushPromises();

    const pills = wrapper.findAll(".api-pill").map((p) => p.text());
    expect(pills).toEqual(["OpenAI 兼容", "Responses"]);
    expect(wrapper.find(".manage-hint").text()).toContain("管理型号");
    expect(wrapper.find(".manage-arrow").exists()).toBe(true);
  });
});

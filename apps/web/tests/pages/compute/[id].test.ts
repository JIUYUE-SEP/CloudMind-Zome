import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import ComputeDetail from "../../../pages/compute/[id].vue";
import type { ModelInfo, Provider } from "@/composables/useEngineClient";

const { navigateToMock, routerPushMock, routeParams } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  routerPushMock: vi.fn(),
  routeParams: { id: "" as string },
}));

mockNuxtImport("navigateTo", () => navigateToMock);
mockNuxtImport("useRoute", () => () => ({ params: routeParams }));
mockNuxtImport("useRouter", () => () => ({ push: routerPushMock }));

const provider: Provider = {
  id: "p1",
  displayName: "OpenAI",
  providerType: "openai",
  baseUrl: "https://api.openai.com/v1",
  models: [],
};

function mountOptions() {
  return { global: { stubs: { NuxtLink: true } } };
}

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
    if (handler && (url.includes("/test") || (url.endsWith("/models") && method === "POST"))) {
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

describe("compute 管理页：型号管理", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    navigateToMock.mockClear();
    routerPushMock.mockClear();
    routeParams.id = "p1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("添加型号提交能力字段，型号行展示能力标记", async () => {
    const providerWithCapabilities: Provider = {
      ...provider,
      models: [
        {
          id: "existing-model",
          displayName: "Existing Model",
          modelType: "llm",
          contextWindow: 1_000_000,
          supportsReasoning: true,
        },
      ],
    };
    const { fetchMock, calls } = mockFetch(undefined, [providerWithCapabilities]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeDetail, mountOptions());
    await flushPromises();

    // 已填能力字段的既有型号行展示小字标记
    expect(wrapper.find(".model-capabilities").text()).toContain("ctx:1M");
    expect(wrapper.find(".model-capabilities").text()).toContain("推理");

    const modelInputs = wrapper.findAll(".add-model input");
    await modelInputs[0].setValue("claude-3-5-sonnet");
    await modelInputs[2].setValue("200000");
    await modelInputs[3].setValue("8192");
    await modelInputs[4].setValue(true); // supportsReasoning
    await modelInputs[5].setValue(true); // supportsToolCalling
    const addBtn = wrapper.findAll("button").find((b) => b.text().includes("添加型号"));
    expect(addBtn).toBeTruthy();
    await addBtn!.trigger("click");
    await flushPromises();

    const addModelCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/compute/providers/p1/models"),
    );
    expect(addModelCall).toBeTruthy();
    expect(addModelCall!.body).toMatchObject({
      id: "claude-3-5-sonnet",
      modelType: "llm",
      contextWindow: 200000,
      maxOutputTokens: 8192,
      supportsReasoning: true,
      supportsToolCalling: true,
    });
    // R5（review）：未勾选的能力字段不落 body（区别于明确 false）
    expect(addModelCall!.body).not.toHaveProperty("supportsMultimodal");
  });

  it("未勾选能力时提交 body 不含三个能力字段", async () => {
    const { fetchMock, calls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeDetail, mountOptions());
    await flushPromises();

    const modelInputs = wrapper.findAll(".add-model input");
    await modelInputs[0].setValue("plain-model");
    const addBtn = wrapper.findAll("button").find((b) => b.text().includes("添加型号"));
    expect(addBtn).toBeTruthy();
    await addBtn!.trigger("click");
    await flushPromises();

    const addModelCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/compute/providers/p1/models"),
    );
    expect(addModelCall).toBeTruthy();
    expect(addModelCall!.body).toMatchObject({ id: "plain-model", modelType: "llm" });
    expect(addModelCall!.body).not.toHaveProperty("supportsReasoning");
    expect(addModelCall!.body).not.toHaveProperty("supportsToolCalling");
    expect(addModelCall!.body).not.toHaveProperty("supportsMultimodal");
  });

  it("顶部展示 provider 名称、协议徽标与 Base URL 摘要", async () => {
    const anthropicProvider: Provider = {
      ...provider,
      apiMode: "anthropic",
    };
    const { fetchMock } = mockFetch(undefined, [anthropicProvider]);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeDetail, mountOptions());
    await flushPromises();

    expect(wrapper.find(".head-title h1").text()).toBe("OpenAI");
    expect(wrapper.find(".api-pill").text()).toBe("Anthropic");
    expect(wrapper.find(".base-url-summary").text()).toBe("https://api.openai.com/v1");
  });

  it("返回按钮逐级回列表页", async () => {
    const { fetchMock } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeDetail, mountOptions());
    await flushPromises();

    await wrapper.find(".back-btn").trigger("click");
    expect(routerPushMock).toHaveBeenCalledWith("/compute");
  });
});

describe("compute 管理页：测试连接与一键导入", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routeParams.id = "p1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("测试成功后 discovered 型号以 chip 展示并全部导入去重", async () => {
    const providerWithModels: Provider = {
      ...provider,
      models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
    };
    const discovered: ModelInfo[] = [
      { id: "gpt-4o", displayName: "gpt-4o", modelType: "llm" },
      { id: "gpt-5", displayName: "gpt-5", modelType: "llm" },
      { id: "gpt-5", displayName: "gpt-5", modelType: "llm" },
    ];
    const { fetchMock, calls } = mockFetch(
      () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, discovered }),
        } as unknown as Response),
      [providerWithModels],
    );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeDetail, mountOptions());
    await flushPromises();
    await testButton(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.findAll(".discovered-chip").map((c) => c.text())).toEqual([
      "gpt-4o",
      "gpt-5",
      "gpt-5",
    ]);
    const importBtn = wrapper.findAll("button").find((b) => b.text().includes("全部导入"));
    expect(importBtn).toBeTruthy();
    await importBtn!.trigger("click");
    await flushPromises();

    const modelPosts = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/compute/providers/p1/models"),
    );
    expect(modelPosts).toHaveLength(1);
    expect(modelPosts[0].body).toMatchObject({
      id: "gpt-5",
      displayName: "gpt-5",
      modelType: "llm",
    });
    expect(wrapper.find(".import-feedback").text()).toBe("导入 1 个，跳过 2 个");
  });

  it("导入单项失败不中断并计入失败数", async () => {
    const discovered: ModelInfo[] = [
      { id: "ok-model", displayName: "ok-model", modelType: "llm" },
      { id: "fail-model", displayName: "fail-model", modelType: "llm" },
      { id: "ok-model-2", displayName: "ok-model-2", modelType: "llm" },
    ];
    const { fetchMock, calls } = mockFetch((call) => {
      if (call.url.endsWith("/test")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, discovered }),
        } as unknown as Response);
      }
      if (call.method === "POST" && call.url.endsWith("/models") && call.body?.id === "fail-model") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "Model id already exists: fail-model" }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeDetail, mountOptions());
    await flushPromises();
    await testButton(wrapper).trigger("click");
    await flushPromises();

    const importBtn = wrapper.findAll("button").find((b) => b.text().includes("全部导入"));
    expect(importBtn).toBeTruthy();
    await importBtn!.trigger("click");
    await flushPromises();

    const modelPosts = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/compute/providers/p1/models"),
    );
    // 失败项也照常发起，整批不中断
    expect(modelPosts).toHaveLength(3);
    expect(wrapper.find(".import-feedback").text()).toBe("导入 2 个，跳过 1 个（含失败 1 个）");
  });
});

describe("compute 管理页：兜底", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routeParams.id = "ghost";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ID 不存在时显示兜底与回列表链接，不渲染管理区", async () => {
    const { fetchMock } = mockFetch(undefined, []);
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ComputeDetail, mountOptions());
    await flushPromises();

    expect(wrapper.text()).toContain("Provider 不存在或已删除");
    expect(wrapper.find(".back-link").exists()).toBe(true);
    expect(wrapper.find(".add-model").exists()).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import Compute from "../../pages/compute.vue";
import type { ModelInfo, Provider } from "@/composables/useEngineClient";

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
  handler?: (call: { url: string; method: string }) => Promise<Response> | Response,
  providers: Provider[] = [provider],
) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (handler && url.includes("/test")) return handler({ url, method });
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

describe("compute 页：测试连接反馈", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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

    const wrapper = mount(Compute);
    await flushPromises();

    const btn = testButton(wrapper);
    expect(btn.text()).toBe("测试连接");
    await btn.trigger("click");

    // 进行中：按钮文案变化且禁用
    expect(testButton(wrapper).text()).toBe("测试中...");
    expect(testButton(wrapper).attributes("disabled")).toBeDefined();

    resolveTest!({ ok: true, json: () => Promise.resolve({ ok: true, discovered: [] }) });
    await flushPromises();

    expect(wrapper.find(".test-result").text()).toBe("连接成功");
    expect(testButton(wrapper).text()).toBe("测试连接");
    expect(testButton(wrapper).attributes("disabled")).toBeUndefined();
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

    const wrapper = mount(Compute);
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

    const wrapper = mount(Compute);
    await flushPromises();

    await testButton(wrapper).trigger("click");
    await testButton(wrapper).trigger("click");
    expect(testCalls).toBe(1);

    resolveTest!({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await flushPromises();
  });
});

describe("compute 页：Provider 弹窗与协议选择器", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("添加弹窗渲染 apiMode 选择器且缺省 chat_completions", async () => {
    const { fetchMock } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(Compute);
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

    const wrapper = mount(Compute);
    await flushPromises();
    await wrapper.find(".provider-card").trigger("click");
    await flushPromises();

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

    const wrapper = mount(Compute);
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
});

describe("compute 页：模型能力字段与一键导入", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("添加模型提交能力字段，型号行展示能力标记", async () => {
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

    const wrapper = mount(Compute);
    await flushPromises();
    await wrapper.find(".provider-card").trigger("click");
    await flushPromises();

    // 已填能力字段的既有模型行展示小字标记
    expect(wrapper.find(".model-capabilities").text()).toContain("ctx:1M");
    expect(wrapper.find(".model-capabilities").text()).toContain("推理");

    const modelInputs = wrapper.findAll(".add-model input");
    await modelInputs[0].setValue("claude-3-5-sonnet");
    await modelInputs[2].setValue("200000");
    await modelInputs[3].setValue("8192");
    await modelInputs[4].setValue(true); // supportsReasoning
    await modelInputs[5].setValue(true); // supportsToolCalling
    const addBtn = wrapper.findAll("button").find((b) => b.text().includes("添加模型"));
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
      supportsMultimodal: false,
    });
  });

  it("测试成功后全部导入去重并反馈导入/跳过数量", async () => {
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

    const wrapper = mount(Compute);
    await flushPromises();
    await testButton(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.find(".discovered-models").text()).toBe("gpt-4o、gpt-5、gpt-5");
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
});

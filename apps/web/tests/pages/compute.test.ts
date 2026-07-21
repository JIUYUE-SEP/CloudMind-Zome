import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import Compute from "../../pages/compute.vue";

const provider = {
  id: "p1",
  displayName: "OpenAI",
  providerType: "openai",
  baseUrl: "https://api.openai.com/v1",
  models: [],
};

function mockFetch(handler?: (call: { url: string; method: string }) => Promise<Response> | Response) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (handler && url.includes("/test")) return handler({ url, method });
    if (url.endsWith("/compute/providers") && method === "GET") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([provider]) } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
  }) as unknown as typeof fetch;
}

function testButton(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper.findAll("button").find((b) => b.text().includes("测试"));
  expect(btn).toBeTruthy();
  return btn!;
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
    vi.stubGlobal(
      "fetch",
      mockFetch(
        () =>
          new Promise((resolve) => {
            resolveTest = resolve as unknown as (r: unknown) => void;
          }) as Promise<Response>,
      ),
    );

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
    vi.stubGlobal(
      "fetch",
      mockFetch(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ error: "Test connection failed" }),
        } as unknown as Response),
      ),
    );

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
    vi.stubGlobal(
      "fetch",
      mockFetch(() => {
        testCalls++;
        return new Promise((resolve) => {
          resolveTest = resolve as unknown as (r: unknown) => void;
        }) as Promise<Response>;
      }),
    );

    const wrapper = mount(Compute);
    await flushPromises();

    await testButton(wrapper).trigger("click");
    await testButton(wrapper).trigger("click");
    expect(testCalls).toBe(1);

    resolveTest!({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await flushPromises();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import SettingsPage from "../../pages/settings.vue";

const memory = { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 };

/** sidecarAutoStart 可配的有无两种 config 响应 */
function mockFetch(configBody: Record<string, unknown>) {
  const configPuts: unknown[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const json = (data: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);

    if (url.includes("/config/tools")) return json([]);
    if (url.endsWith("/config") && method === "PUT") {
      configPuts.push(init?.body ? JSON.parse(String(init.body)) : {});
      return json({ memory, sidecarAutoStart: (configPuts.at(-1) as { sidecarAutoStart?: boolean }).sidecarAutoStart });
    }
    if (url.endsWith("/config")) return json({ memory, providers: [], ...configBody });
    if (url.endsWith("/plugins/manifest")) return json({ plugins: [], unregistered: [] });
    if (url.endsWith("/plugins")) return json({ loaded: [], skipped: [], perAgent: [] });
    if (url.endsWith("/agents")) return json([]);
    if (url.includes("/system/info")) return json({ version: "t", dataDir: "/d", port: 1, uptimeSec: 1, sidecar: { configured: false } });
    return json({});
  });
  return { fetchMock, configPuts };
}

describe("设置页 sidecar 自启开关（决策 1：默认 false 恒等）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("config 带 sidecarAutoStart:true：checkbox 勾选；取消勾选保存后 PUT 体为 false", async () => {
    const { fetchMock, configPuts } = mockFetch({ sidecarAutoStart: true });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(SettingsPage);
    await flushPromises();

    const toggle = wrapper.find(".sidecar-toggle");
    expect(toggle.exists()).toBe(true);
    expect((toggle.element as HTMLInputElement).checked).toBe(true);

    await toggle.setValue(false);
    await wrapper.find("button.save").trigger("click");
    await flushPromises();

    expect(configPuts).toHaveLength(1);
    expect((configPuts[0] as { sidecarAutoStart?: boolean }).sidecarAutoStart).toBe(false);
  });

  it("config 缺席该字段：checkbox 不勾选（缺省 false 恒等），勾选保存后 PUT 体为 true", async () => {
    const { fetchMock, configPuts } = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(SettingsPage);
    await flushPromises();

    const toggle = wrapper.find(".sidecar-toggle");
    expect((toggle.element as HTMLInputElement).checked).toBe(false);

    await toggle.setValue(true);
    await wrapper.find("button.save").trigger("click");
    await flushPromises();

    expect((configPuts[0] as { sidecarAutoStart?: boolean }).sidecarAutoStart).toBe(true);
  });
});

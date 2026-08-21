import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { usePluginsStore, skipReasonText, pluginStatusText } from "@/stores/plugins";
import type { PluginSkipReason } from "@/composables/useEngineClient";

const pluginResult = {
  loaded: ["alpha", "beta"],
  skipped: [
    { name: "gamma", reason: "missing-entry" },
    { name: "delta", reason: "import-failed" },
  ],
  perAgent: [
    { agentId: "a1", name: "alpha", status: "loaded" },
    { agentId: "a2", name: "beta", status: "mount-failed" },
  ],
};

function mockFetch(body: unknown, ok = true) {
  return vi.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );
}

describe("plugins store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("load 成功：loaded / skipped / perAgent 三段分别填充", async () => {
    vi.stubGlobal("fetch", mockFetch(pluginResult));
    const store = usePluginsStore();

    await store.load();

    expect(store.error).toBe("");
    expect(store.loaded).toEqual(["alpha", "beta"]);
    expect(store.skipped.map((s) => s.name)).toEqual(["gamma", "delta"]);
    expect(store.perAgent).toHaveLength(2);
  });

  it("load 失败：error 透出 err.message，三段保持空", async () => {
    vi.stubGlobal("fetch", mockFetch({ error: "plugin dir unreadable" }, false));
    const store = usePluginsStore();

    await store.load();

    expect(store.error).toContain("plugin dir unreadable");
    expect(store.loaded).toEqual([]);
    expect(store.skipped).toEqual([]);
    expect(store.perAgent).toEqual([]);
  });

  it("skipReasonText：契约内全部 reason 都有中文文案", () => {
    const reasons: PluginSkipReason[] = [
      "disabled",
      "invalid-entry",
      "missing-entry",
      "import-failed",
      "no-apply",
      "invalid-name",
      "name-mismatch",
      "mount-failed",
      "apply-failed",
      "pending",
    ];
    for (const r of reasons) {
      // 命中映射的文案不应再是英文原值
      expect(skipReasonText(r)).not.toBe(r);
    }
    expect(skipReasonText("missing-entry")).toBe("缺少入口文件");
    expect(skipReasonText("import-failed")).toBe("导入失败");
    // 契约外新增值兜底原样透出
    expect(skipReasonText("future-reason" as PluginSkipReason)).toBe("future-reason");
  });

  it("pluginStatusText：loaded 是「已加载」，其余走 reason 文案", () => {
    expect(pluginStatusText("loaded")).toBe("已加载");
    expect(pluginStatusText("mount-failed")).toBe("挂载失败");
  });
});

// ---- M2 管理面：全局清单读写 + per-agent 清单读写 ----

const manifestPayload = {
  plugins: [
    { name: "alpha", enabled: true, config: { key: "v" }, hasEntry: true as const },
    { name: "beta", enabled: false, config: {}, hasEntry: true as const },
  ],
  unregistered: ["gamma"],
};

const agentManifests: Record<string, { name: string; enabled: boolean; config: Record<string, unknown> }[]> = {
  a1: [{ name: "alpha", enabled: true, config: {} }],
  a2: [{ name: "delta", enabled: false, config: {} }],
};

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

/** manifest 相关路由 mock：PUT 按补丁回显条目视图（engine 同款响应形状），可注入读写失败 */
function mockManifestFetch(options?: {
  manifestFail?: { status: number; error: string };
  putFail?: { status: number; error: string };
}) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (data: unknown, ok = true, status = 200) =>
      Promise.resolve({ ok, status, json: () => Promise.resolve(data) } as unknown as Response);

    // 写（全局与 per-agent 同形状：{...条目视图, requiresRestart: true}）
    if (method === "PUT" && url.includes("/plugins/manifest/")) {
      if (options?.putFail) return json({ error: options.putFail.error }, false, options.putFail.status);
      const name = decodeURIComponent(url.split("/plugins/manifest/")[1]);
      const patch = (body ?? {}) as { enabled?: boolean; config?: Record<string, unknown> };
      return json({ name, enabled: patch.enabled ?? true, config: patch.config ?? {}, requiresRestart: true });
    }
    // per-agent 读（克隆返回：store 写操作会原地更新条目，直接共享 fixture 会跨用例污染）
    if (url.includes("/agents/") && url.endsWith("/plugins/manifest")) {
      const agentId = decodeURIComponent(url.split("/agents/")[1].split("/")[0]);
      return json(structuredClone({ plugins: agentManifests[agentId] ?? [] }));
    }
    // 全局读（同上：克隆隔离）
    if (url.endsWith("/plugins/manifest")) {
      if (options?.manifestFail) return json({ error: options.manifestFail.error }, false, options.manifestFail.status);
      return json(structuredClone(manifestPayload));
    }
    if (url.endsWith("/plugins")) return json(pluginResult);
    return json({});
  });
  return { fetchMock, calls };
}

describe("plugins store 管理面（M2）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loadManifest 成功：清单条目与未登记目录分列", async () => {
    const { fetchMock } = mockManifestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();

    await store.loadManifest();

    expect(store.manifestError).toBe("");
    expect(store.manifestEntries.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(store.unregistered).toEqual(["gamma"]);
  });

  it("loadManifest 409 损坏：manifestError 透出 err.message，清单保持空", async () => {
    const { fetchMock } = mockManifestFetch({ manifestFail: { status: 409, error: "plugins.json 解析失败" } });
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();

    await store.loadManifest();

    expect(store.manifestError).toContain("plugins.json 解析失败");
    expect(store.manifestEntries).toEqual([]);
    expect(store.unregistered).toEqual([]);
  });

  it("setPluginEnabled 成功：PUT {enabled} 形状正确，条目更新并出现重启提示", async () => {
    const { fetchMock, calls } = mockManifestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();
    await store.loadManifest();

    const ok = await store.setPluginEnabled("alpha", false);

    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/plugins/manifest/alpha");
    expect(put?.body).toEqual({ enabled: false });
    expect(store.manifestEntries.find((e) => e.name === "alpha")?.enabled).toBe(false);
    expect(store.restartHint).toBe(true);
    expect(store.writeError).toBe("");
  });

  it("setPluginEnabled 失败：返回 false（UI 据此回弹），writeError 透出 err.message，条目状态不变", async () => {
    const { fetchMock } = mockManifestFetch({ putFail: { status: 409, error: "plugins.json 解析失败：bad token" } });
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();
    await store.loadManifest();

    const ok = await store.setPluginEnabled("alpha", false);

    expect(ok).toBe(false);
    expect(store.writeError).toContain("bad token");
    expect(store.manifestEntries.find((e) => e.name === "alpha")?.enabled).toBe(true);
    expect(store.restartHint).toBe(false);
  });

  it("register 成功：PUT {enabled:true}，条目从未登记区移入清单区", async () => {
    const { fetchMock, calls } = mockManifestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();
    await store.loadManifest();

    const ok = await store.register("gamma");

    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/plugins/manifest/gamma");
    expect(put?.body).toEqual({ enabled: true });
    expect(store.unregistered).toEqual([]);
    expect(store.manifestEntries.map((e) => e.name)).toContain("gamma");
    expect(store.restartHint).toBe(true);
  });

  it("savePluginConfig 成功：PUT {config}，条目 config 整体替换", async () => {
    const { fetchMock, calls } = mockManifestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();
    await store.loadManifest();

    const ok = await store.savePluginConfig("alpha", { key: "new" });

    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ config: { key: "new" } });
    expect(store.manifestEntries.find((e) => e.name === "alpha")?.config).toEqual({ key: "new" });
  });

  it("savePluginConfig 409 损坏：writeError 透出，原 config 不变", async () => {
    const { fetchMock } = mockManifestFetch({ putFail: { status: 409, error: "plugins.json 解析失败" } });
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();
    await store.loadManifest();

    const ok = await store.savePluginConfig("alpha", { key: "new" });

    expect(ok).toBe(false);
    expect(store.writeError).toContain("plugins.json 解析失败");
    expect(store.manifestEntries.find((e) => e.name === "alpha")?.config).toEqual({ key: "v" });
  });

  it("selectAgent：加载该 agent 清单；切换后重新加载并替换条目", async () => {
    const { fetchMock, calls } = mockManifestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();

    await store.selectAgent("a1");
    expect(store.selectedAgentId).toBe("a1");
    expect(store.agentEntries.map((e) => e.name)).toEqual(["alpha"]);

    await store.selectAgent("a2");
    expect(store.selectedAgentId).toBe("a2");
    expect(store.agentEntries.map((e) => e.name)).toEqual(["delta"]);
    const agentGets = calls.filter((c) => c.method === "GET" && c.url.includes("/agents/"));
    expect(agentGets.map((c) => c.url)).toEqual([
      expect.stringContaining("/agents/a1/plugins/manifest"),
      expect.stringContaining("/agents/a2/plugins/manifest"),
    ]);
  });

  it("setAgentPluginEnabled 成功：PUT per-agent 形状正确并更新条目", async () => {
    const { fetchMock, calls } = mockManifestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();
    await store.selectAgent("a1");

    const ok = await store.setAgentPluginEnabled("alpha", false);

    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/agents/a1/plugins/manifest/alpha");
    expect(put?.body).toEqual({ enabled: false });
    expect(store.agentEntries[0].enabled).toBe(false);
    expect(store.restartHint).toBe(true);
  });

  it("setAgentPluginEnabled 未选 agent 时直接 false，不发请求", async () => {
    const { fetchMock, calls } = mockManifestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = usePluginsStore();

    const ok = await store.setAgentPluginEnabled("alpha", false);

    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});

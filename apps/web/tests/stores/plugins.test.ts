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

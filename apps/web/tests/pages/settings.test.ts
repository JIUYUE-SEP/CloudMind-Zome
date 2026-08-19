import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import SettingsPage from "../../pages/settings.vue";

const configData = {
  memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
  tavilyApiKey: "***",
  providers: [],
};

const pluginResult = {
  loaded: ["alpha"],
  skipped: [{ name: "gamma", reason: "missing-entry" }],
  perAgent: [
    { agentId: "a1", name: "alpha", status: "loaded" },
    { agentId: "a2", name: "beta", status: "mount-failed" },
  ],
};

const systemInfo = {
  version: "1.2.3",
  gitCommit: "abc1234567def",
  dataDir: "/data/cloudmind",
  port: 18790,
  uptimeSec: 3661,
  sidecar: { configured: true },
};

function mockFetch(options?: { pluginsFail?: boolean; noGitCommit?: boolean }) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (data: unknown, ok = true, status = 200) =>
      Promise.resolve({ ok, status, json: () => Promise.resolve(data) } as unknown as Response);

    if (url.includes("/config/tools")) return json([{ name: "search", toolset: "web", safeToParallel: true }]);
    if (url.endsWith("/config")) return json(configData);
    if (url.endsWith("/plugins")) {
      return options?.pluginsFail ? json({ error: "plugin dir unreadable" }, false, 500) : json(pluginResult);
    }
    if (url.includes("/system/info")) {
      const info = options?.noGitCommit ? { ...systemInfo, gitCommit: undefined } : systemInfo;
      return json(info);
    }
    return json({});
  });
}

async function mountPage() {
  const wrapper = mount(SettingsPage);
  await flushPromises();
  return wrapper;
}

/** 按标签名找到系统信息里的行 */
function findInfoRow(wrapper: ReturnType<typeof mount>, label: string) {
  const row = wrapper.findAll("li").find((li) => li.text().includes(label));
  expect(row).toBeTruthy();
  return row!;
}

describe("设置页：外部插件与系统信息", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("外部插件节：三段清单渲染，跳过原因给中文文案", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("外部插件");
    // 已加载
    expect(wrapper.text()).toContain("已加载（1）");
    expect(wrapper.text()).toContain("alpha");
    // 已跳过：名称 + 中文原因（不裸透英文枚举）
    expect(wrapper.text()).toContain("已跳过（1）");
    expect(wrapper.text()).toContain("gamma");
    expect(wrapper.text()).toContain("缺少入口文件");
    expect(wrapper.text()).not.toContain("missing-entry");
    // perAgent：agentId + 状态文案
    expect(wrapper.text()).toContain("按 Agent 挂载（2）");
    expect(wrapper.text()).toContain("a2");
    expect(wrapper.text()).toContain("挂载失败");
  });

  it("系统信息节：版本带 git 短哈希，运行时长人性化，sidecar 注明口径", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const wrapper = await mountPage();

    expect(findInfoRow(wrapper, "版本").text()).toContain("1.2.3");
    expect(findInfoRow(wrapper, "版本").text()).toContain("abc1234");
    expect(wrapper.text()).not.toContain("abc1234567");
    expect(findInfoRow(wrapper, "数据目录").text()).toContain("/data/cloudmind");
    expect(findInfoRow(wrapper, "引擎端口").text()).toContain("18790");
    // 3661 秒 → 1 小时 1 分
    expect(findInfoRow(wrapper, "运行时长").text()).toContain("1 小时 1 分");
    expect(findInfoRow(wrapper, "Sidecar").text()).toContain("已配置");
    // V1 如实注明 configured 含义
    expect(wrapper.text()).toContain("不代表 sidecar 进程正在运行");
  });

  it("gitCommit 缺省时版本行不显示哈希", async () => {
    vi.stubGlobal("fetch", mockFetch({ noGitCommit: true }));
    const wrapper = await mountPage();

    const versionRow = findInfoRow(wrapper, "版本");
    expect(versionRow.text()).toContain("1.2.3");
    expect(versionRow.text()).not.toContain("（");
  });

  it("插件接口失败：节内透出错误，不阻塞设置表单", async () => {
    vi.stubGlobal("fetch", mockFetch({ pluginsFail: true }));
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("plugin dir unreadable");
    // 设置表单与系统信息不受影响
    expect(wrapper.text()).toContain("记忆参数");
    expect(findInfoRow(wrapper, "版本").text()).toContain("1.2.3");
  });
});

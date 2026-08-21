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

const agentList = [
  { id: "a1", name: "Alpha", persona: "", skills: [], tools: [] },
  { id: "a2", name: "Beta", persona: "", skills: [], tools: [] },
];

const manifestData = {
  plugins: [
    { name: "alpha", enabled: true, config: { greeting: "hi" }, hasEntry: true },
    { name: "beta", enabled: false, config: {}, hasEntry: true },
  ],
  unregistered: ["gamma"],
};

const agentManifests: Record<string, { name: string; enabled: boolean; config: Record<string, unknown> }[]> = {
  a1: [{ name: "alpha", enabled: true, config: {} }],
  a2: [{ name: "delta", enabled: false, config: {} }],
};

interface MockOptions {
  pluginsFail?: boolean;
  manifestFail?: boolean;
  putFail?: boolean;
  noGitCommit?: boolean;
}

/** 全路由 mock：设置(config/tools)/插件只读(plugins)/管理面(manifest 读写)/agents/系统信息 */
function mockFetch(options?: MockOptions) {
  const putCalls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const json = (data: unknown, ok = true, status = 200) =>
      Promise.resolve({ ok, status, json: () => Promise.resolve(data) } as unknown as Response);

    if (url.includes("/config/tools")) return json([{ name: "search", toolset: "web", safeToParallel: true }]);
    if (url.endsWith("/config")) return json(configData);
    // 管理面写（全局与 per-agent 同形状：按补丁回显条目视图 + requiresRestart）
    if (method === "PUT" && url.includes("/plugins/manifest/")) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      putCalls.push({ url, body });
      if (options?.putFail) return json({ error: "plugins.json 解析失败：bad token" }, false, 409);
      const name = decodeURIComponent(url.split("/plugins/manifest/")[1]);
      const patch = (body ?? {}) as { enabled?: boolean; config?: Record<string, unknown> };
      return json({ name, enabled: patch.enabled ?? true, config: patch.config ?? {}, requiresRestart: true });
    }
    // per-agent 清单读（克隆返回：store 写操作会原地更新条目，直接共享 fixture 会跨用例污染）
    if (url.includes("/agents/") && url.endsWith("/plugins/manifest")) {
      const agentId = decodeURIComponent(url.split("/agents/")[1].split("/")[0]);
      return json(structuredClone({ plugins: agentManifests[agentId] ?? [] }));
    }
    // 全局清单读（同上：克隆隔离）
    if (url.endsWith("/plugins/manifest")) {
      return options?.manifestFail
        ? json({ error: "plugins.json 结构非法：plugins 字段不是对象" }, false, 409)
        : json(structuredClone(manifestData));
    }
    if (url.endsWith("/plugins")) {
      return options?.pluginsFail ? json({ error: "plugin dir unreadable" }, false, 500) : json(pluginResult);
    }
    if (url.endsWith("/agents")) return json(agentList);
    if (url.includes("/system/info")) {
      const info = options?.noGitCommit ? { ...systemInfo, gitCommit: undefined } : systemInfo;
      return json(info);
    }
    return json({});
  });
  return { fetchMock, putCalls };
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
    vi.stubGlobal("fetch", mockFetch().fetchMock);
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
    vi.stubGlobal("fetch", mockFetch().fetchMock);
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
    vi.stubGlobal("fetch", mockFetch({ noGitCommit: true }).fetchMock);
    const wrapper = await mountPage();

    const versionRow = findInfoRow(wrapper, "版本");
    expect(versionRow.text()).toContain("1.2.3");
    expect(versionRow.text()).not.toContain("（");
  });

  it("插件接口失败：节内透出错误，不阻塞设置表单", async () => {
    vi.stubGlobal("fetch", mockFetch({ pluginsFail: true }).fetchMock);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("plugin dir unreadable");
    // 设置表单与系统信息不受影响
    expect(wrapper.text()).toContain("记忆参数");
    expect(findInfoRow(wrapper, "版本").text()).toContain("1.2.3");
  });
});

describe("设置页：外部插件管理面（M2）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("管理清单区：条目带开关与配置按钮，未登记目录单列徽标与登记按钮", async () => {
    vi.stubGlobal("fetch", mockFetch().fetchMock);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("插件清单（2）");
    const rows = wrapper.findAll("li.manifest-row");
    expect(rows).toHaveLength(2);
    expect((rows[0].find("input.enabled-toggle").element as HTMLInputElement).checked).toBe(true);
    expect((rows[1].find("input.enabled-toggle").element as HTMLInputElement).checked).toBe(false);
    expect(rows[0].find("button.config-btn").exists()).toBe(true);
    // 未登记区：徽标 + 登记按钮
    expect(wrapper.text()).toContain("未登记（1）");
    const registerBtn = wrapper.find("button.register-btn");
    expect(registerBtn.exists()).toBe(true);
    expect(registerBtn.text()).toBe("登记");
  });

  it("开关：点击即 PUT {enabled}，成功后出现重启提示", async () => {
    const { fetchMock, putCalls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    const toggle = wrapper.find("li.manifest-row input.enabled-toggle");
    await toggle.setValue(false);
    await flushPromises();

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].url).toContain("/plugins/manifest/alpha");
    expect(putCalls[0].body).toEqual({ enabled: false });
    expect((toggle.element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.text()).toContain("变更将在 engine 重启后生效");
  });

  it("开关：PUT 失败透出 err.message 且开关回弹", async () => {
    const { fetchMock } = mockFetch({ putFail: true });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    const toggle = wrapper.find("li.manifest-row input.enabled-toggle");
    await toggle.setValue(false);
    await flushPromises();

    expect(wrapper.text()).toContain("bad token");
    // 回弹：DOM 与 store 状态都保持原值（alpha 缺省启用）
    expect((toggle.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.text()).not.toContain("变更将在 engine 重启后生效");
  });

  it("登记：点击后 PUT {enabled:true}，条目从未登记区移入清单区", async () => {
    const { fetchMock, putCalls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    await wrapper.find("button.register-btn").trigger("click");
    await flushPromises();

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].url).toContain("/plugins/manifest/gamma");
    expect(putCalls[0].body).toEqual({ enabled: true });
    expect(wrapper.text()).toContain("未登记（0）");
    expect(wrapper.text()).toContain("插件清单（3）");
    expect(wrapper.findAll("li.manifest-row")).toHaveLength(3);
    expect(wrapper.text()).toContain("变更将在 engine 重启后生效");
  });

  it("config 编辑：非法 JSON 与数组被拦截不发 PUT，合法对象保存后 PUT 并收起", async () => {
    const { fetchMock, putCalls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    // 展开 alpha 的配置编辑器：初始文本是该条目 config 的格式化 JSON
    await wrapper.find("li.manifest-row button.config-btn").trigger("click");
    const textarea = wrapper.find("textarea.config-textarea");
    expect(textarea.exists()).toBe(true);
    expect((textarea.element as HTMLTextAreaElement).value).toContain('"greeting"');

    // 非法 JSON：给错误提示，不发 PUT
    await textarea.setValue("not json {");
    await wrapper.find("button.config-save").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("JSON 格式非法");
    expect(putCalls).toHaveLength(0);

    // 合法 JSON 但非对象（数组）：同样拦截
    await textarea.setValue("[1, 2]");
    await wrapper.find("button.config-save").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("配置必须是 JSON 对象");
    expect(putCalls).toHaveLength(0);

    // 合法对象：PUT config，编辑器收起，出现重启提示
    await textarea.setValue('{ "greeting": "hello" }');
    await wrapper.find("button.config-save").trigger("click");
    await flushPromises();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].url).toContain("/plugins/manifest/alpha");
    expect(putCalls[0].body).toEqual({ config: { greeting: "hello" } });
    expect(wrapper.find("textarea.config-textarea").exists()).toBe(false);
    expect(wrapper.text()).toContain("变更将在 engine 重启后生效");
  });

  it("config 保存写失败（409）：编辑器保持打开，错误透出", async () => {
    const { fetchMock } = mockFetch({ putFail: true });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    await wrapper.find("li.manifest-row button.config-btn").trigger("click");
    await wrapper.find("textarea.config-textarea").setValue('{ "k": 1 }');
    await wrapper.find("button.config-save").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("bad token");
    expect(wrapper.find("textarea.config-textarea").exists()).toBe(true);
  });

  it("manifest 409 损坏：节内透出 engine 错误正文", async () => {
    const { fetchMock } = mockFetch({ manifestFail: true });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("plugins 字段不是对象");
  });

  it("per-agent：默认选第一个 agent 并加载其清单，切换后重新加载", async () => {
    vi.stubGlobal("fetch", mockFetch().fetchMock);
    const wrapper = await mountPage();

    // 默认选中 a1：其清单条目（alpha，启用）出现在 per-agent 区
    const select = wrapper.find("select.agent-select");
    expect((select.element as HTMLSelectElement).value).toBe("a1");
    const toggles = wrapper.findAll("input.agent-enabled-toggle");
    expect(toggles).toHaveLength(1);
    expect((toggles[0].element as HTMLInputElement).checked).toBe(true);

    // 切换 a2：重新加载，条目换成 delta（缺省禁用）
    await select.setValue("a2");
    await flushPromises();
    const togglesAfter = wrapper.findAll("input.agent-enabled-toggle");
    expect(togglesAfter).toHaveLength(1);
    expect((togglesAfter[0].element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.text()).toContain("delta");
  });

  it("per-agent 开关：PUT per-agent 端点，形状正确并出现重启提示", async () => {
    const { fetchMock, putCalls } = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPage();

    const toggle = wrapper.find("input.agent-enabled-toggle");
    await toggle.setValue(false);
    await flushPromises();

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].url).toContain("/agents/a1/plugins/manifest/alpha");
    expect(putCalls[0].body).toEqual({ enabled: false });
    expect(wrapper.text()).toContain("变更将在 engine 重启后生效");
  });
});

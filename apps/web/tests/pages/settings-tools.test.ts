import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import SettingsToolsPage from "../../pages/settings.tools.vue";

const agentList = [
  { id: "a1", name: "Alpha", persona: "", skills: [], tools: [] },
  { id: "a2", name: "Beta", persona: "", skills: [], tools: [] },
];

interface DynState {
  name: string;
  blurb: string;
  source?: string;
  status: string;
}
interface SkillState {
  name: string;
  authorLine: string;
  overrideBlurb?: string;
  source?: string;
  status: string;
}

function freshState() {
  return {
    dynamic: [
      { name: "mcp__fs__read", blurb: "读取文件", source: "llm", status: "llm" },
      { name: "mcp__fs__write", blurb: "写入文件", source: "user", status: "user" },
      { name: "mcp__net__fetch", blurb: "抓取网页", status: "missing" },
      { name: "mcp__old__tool", blurb: "旧简介", source: "llm", status: "stale" },
    ] as DynState[],
    skills: [
      { name: "deploy", authorLine: "作者行：部署技能。", status: "missing" },
      { name: "review", authorLine: "作者行：审查技能。", overrideBlurb: "用户审", source: "user", status: "user" },
    ] as SkillState[],
    builtin: [
      { name: "read_file", blurb: "读取文件", status: "core" },
      { name: "bash", blurb: "执行命令", status: "core" },
    ],
  };
}

function mockFetch(state: ReturnType<typeof freshState>) {
  const putCalls: { url: string; body: unknown }[] = [];
  const postCalls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const json = (data: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);

    if (url.endsWith("/agents")) return json(agentList);
    if (method === "PUT" && url.includes("/tool-blurbs/")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const name = decodeURIComponent(url.split("/tool-blurbs/")[1]);
      putCalls.push({ url, body });
      const blurb = String(body.blurb ?? "");
      if (name.startsWith("skill:")) {
        const skill = state.skills.find((s) => s.name === name.slice(6));
        if (skill) Object.assign(skill, { overrideBlurb: blurb, source: "user", status: "user" });
      } else {
        const dyn = state.dynamic.find((d) => d.name === name);
        if (dyn) Object.assign(dyn, { blurb, source: "user", status: "user" });
      }
      return json({ blurb, descHash: "h", source: "user", updatedAt: "t" });
    }
    if (method === "POST" && url.includes("/tool-blurbs/regenerate")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      postCalls.push({ url, body });
      const names: string[] = Array.isArray(body.names)
        ? body.names
        : [
            ...state.dynamic.filter((d) => d.status === "missing" || d.status === "stale").map((d) => d.name),
            ...state.skills.filter((s) => s.status === "missing" || s.status === "stale").map((s) => `skill:${s.name}`),
          ];
      for (const n of names) {
        if (n.startsWith("skill:")) {
          const skill = state.skills.find((s) => s.name === n.slice(6));
          if (skill) Object.assign(skill, { overrideBlurb: "新生成", source: "llm", status: "llm" });
        } else {
          const dyn = state.dynamic.find((d) => d.name === n);
          if (dyn) Object.assign(dyn, { blurb: "新生成", source: "llm", status: "llm" });
        }
      }
      return json({ generated: names, failed: [], skipped: [] });
    }
    if (url.includes("/tool-catalog")) return json(structuredClone(state));
    return json({});
  });
  return { fetchMock, putCalls, postCalls };
}

function rowOf(wrapper: ReturnType<typeof mount>, name: string) {
  const row = wrapper.findAll(".rows li").find((li) => li.text().includes(name));
  expect(row).toBeTruthy();
  return row!;
}

describe("settings/tools 子页面（blurb 管理 v3）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("三清单渲染：dynamic/skills/builtin 三节齐，builtin 只读无编辑按钮", async () => {
    const state = freshState();
    vi.stubGlobal("fetch", mockFetch(state).fetchMock);
    const wrapper = mount(SettingsToolsPage);
    await flushPromises();

    expect(wrapper.text()).toContain("MCP 工具（4）");
    expect(wrapper.text()).toContain("Skills（2）");
    expect(wrapper.text()).toContain("内置工具（2，只读）");
    expect(rowOf(wrapper, "mcp__fs__read").text()).toContain("读取文件");
    // skills：命中覆盖行的行展示覆盖行 + 作者行备注
    expect(rowOf(wrapper, "review").text()).toContain("用户审");
    expect(rowOf(wrapper, "review").text()).toContain("作者行：审查技能。");
    // builtin 节只读：其行内无编辑/重生成按钮
    const builtinRow = rowOf(wrapper, "read_file");
    expect(builtinRow.find(".edit-btn").exists()).toBe(false);
    expect(builtinRow.text()).toContain("常驻");
  });

  it("徽标四态映射：待生成灰 / LLM 蓝 / 已编辑绿 / 已过期黄", async () => {
    const state = freshState();
    vi.stubGlobal("fetch", mockFetch(state).fetchMock);
    const wrapper = mount(SettingsToolsPage);
    await flushPromises();

    const expectBadge = (name: string, text: string, cls: string) => {
      const badge = rowOf(wrapper, name).find(".badge");
      expect(badge.text()).toBe(text);
      expect(badge.classes()).toContain(cls);
    };
    expectBadge("mcp__fs__read", "LLM", "badge-llm");
    expectBadge("mcp__fs__write", "已编辑", "badge-user");
    expectBadge("mcp__net__fetch", "待生成", "badge-missing");
    expectBadge("mcp__old__tool", "已过期", "badge-stale");
  });

  it("行内编辑：保存后 PUT 形状正确、刷新徽标转 user", async () => {
    const state = freshState();
    const { fetchMock, putCalls } = mockFetch(state);
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(SettingsToolsPage);
    await flushPromises();

    const row = rowOf(wrapper, "mcp__net__fetch");
    expect(row.find(".badge").text()).toBe("待生成");
    await row.find(".edit-btn").trigger("click");
    await wrapper.find(".blurb-input").setValue("手改抓取");
    await wrapper.find(".save-btn").trigger("click");
    await flushPromises();

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.url).toContain(`/tool-blurbs/${encodeURIComponent("mcp__net__fetch")}`);
    expect(putCalls[0]!.body).toEqual({ blurb: "手改抓取" });
    expect(rowOf(wrapper, "mcp__net__fetch").find(".badge").text()).toBe("已编辑");
    expect(wrapper.text()).toContain("已保存——L1 目录行下次会话生效"); // 提示统一：dynamic 件同样带
  });

  it("skill 编辑：保存提示「下次会话生效」（reviewer 交接语）", async () => {
    const state = freshState();
    const { fetchMock, putCalls } = mockFetch(state);
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(SettingsToolsPage);
    await flushPromises();

    const row = rowOf(wrapper, "deploy");
    await row.find(".edit-btn").trigger("click");
    await wrapper.find(".blurb-input").setValue("手改部署");
    await wrapper.find(".save-btn").trigger("click");
    await flushPromises();

    expect(putCalls[0]!.url).toContain(encodeURIComponent("skill:deploy"));
    expect(wrapper.text()).toContain("已保存——L1 目录行下次会话生效");
    expect(rowOf(wrapper, "deploy").find(".badge").text()).toBe("已编辑");
  });

  it("重生成：按件带 names；全部重新生成发空 body（缺省 missing/stale）", async () => {
    const state = freshState();
    const { fetchMock, postCalls } = mockFetch(state);
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(SettingsToolsPage);
    await flushPromises();

    // 按件
    await rowOf(wrapper, "mcp__old__tool").find(".regen-btn").trigger("click");
    await flushPromises();
    expect(postCalls[0]!.body).toEqual({ names: ["mcp__old__tool"] });
    expect(rowOf(wrapper, "mcp__old__tool").find(".badge").text()).toBe("LLM");

    // 全部：空 body（无 names 字段），缺省由 engine 只碰 missing/stale
    await wrapper.find("button.save").trigger("click");
    await flushPromises();
    expect(postCalls[1]!.body).toEqual({});
    // 此时 missing 件 = mcp__net__fetch + skill:deploy 两件
    expect(wrapper.text()).toContain("已生成 2 件");
    expect(rowOf(wrapper, "deploy").find(".badge").text()).toBe("LLM");
  });
});

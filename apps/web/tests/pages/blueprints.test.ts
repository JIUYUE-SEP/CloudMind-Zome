import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import BlueprintPage from "../../pages/blueprints/[id].vue";

const { routeParams } = vi.hoisted(() => ({
  routeParams: { id: "bp1" as string },
}));

mockNuxtImport("useRoute", () => () => ({ params: routeParams }));

const blueprint = {
  id: "bp1",
  name: "测试蓝图",
  nodes: [{ id: "n1", type: "start", x: 0, y: 0 }],
  edges: [],
  createdAt: "",
  updatedAt: "",
};

const execution = {
  id: "e1",
  blueprintId: "bp1",
  status: "completed",
  startedAt: "",
  outputs: {},
  logs: [],
};

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

function mockBlueprintFetch(options?: { putFails?: boolean }) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.includes("/blueprints/bp1/execute") && method === "POST") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(execution) } as unknown as Response);
    }
    if (url.endsWith("/blueprints/bp1") && method === "GET") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(blueprint) } as unknown as Response);
    }
    if (url.endsWith("/blueprints/bp1") && method === "PUT") {
      if (options?.putFails) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "db locked" }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...blueprint, ...body }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
  });
  return { fetchMock, calls };
}

const canvasStub = {
  name: "BlueprintCanvas",
  template: "<div class='canvas-stub'></div>",
  emits: ["update", "save", "execute"],
};

async function mountPage() {
  const wrapper = mount(BlueprintPage, { global: { stubs: { BlueprintCanvas: canvasStub } } });
  await flushPromises();
  return wrapper;
}

/** 点击执行面板里的"执行"按钮 */
async function clickExecute(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper
    .findAll(".execution-panel button")
    .find((b) => b.text() === "执行");
  expect(btn).toBeTruthy();
  await btn!.trigger("click");
  await flushPromises();
}

describe("蓝图编辑页：执行前自动保存", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routeParams.id = "bp1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("画布未修改时直接执行，不发 PUT", async () => {
    const { fetchMock, calls } = mockBlueprintFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await mountPage();
    expect(wrapper.text()).not.toContain("未保存");

    await clickExecute(wrapper);

    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(calls.some((c) => c.url.includes("/execute") && c.method === "POST")).toBe(true);
  });

  it("画布有未保存修改时先 PUT 再执行，顺序保证", async () => {
    const { fetchMock, calls } = mockBlueprintFetch();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await mountPage();
    // 模拟画布编辑
    wrapper
      .findComponent({ name: "BlueprintCanvas" })
      .vm.$emit("update", [...blueprint.nodes, { id: "n2", type: "end", x: 1, y: 1 }], []);
    await flushPromises();
    expect(wrapper.text()).toContain("未保存");

    await clickExecute(wrapper);

    const putIdx = calls.findIndex((c) => c.method === "PUT");
    const execIdx = calls.findIndex((c) => c.url.includes("/execute"));
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThan(putIdx);
    // 自动保存提交的是画布最新内容
    expect((calls[putIdx]!.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual([
      "n1",
      "n2",
    ]);
    expect(wrapper.text()).not.toContain("未保存");
  });

  it("自动保存失败则不执行", async () => {
    const { fetchMock, calls } = mockBlueprintFetch({ putFails: true });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await mountPage();
    wrapper.findComponent({ name: "BlueprintCanvas" }).vm.$emit("update", [], []);
    await flushPromises();

    await clickExecute(wrapper);

    expect(calls.some((c) => c.url.includes("/execute"))).toBe(false);
    expect(wrapper.text()).toContain("自动保存失败");
  });
});

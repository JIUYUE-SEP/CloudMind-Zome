import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import DefaultLayout from "../../layouts/default.vue";

// 布局显式 import { useRoute } from "vue-router"（非 Nuxt 自动导入，mockNuxtImport
// 拦不到），故直接拦 vue-router 模块；其余导出保持原样
const { routeState } = vi.hoisted(() => ({ routeState: { path: "/" } }));
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return { ...actual, useRoute: () => ({ path: routeState.path }) };
});

// NuxtLink 打桩为朴素锚点（class 沿 attr 透传），聚焦断言导航映射本身
const NuxtLinkStub = {
  name: "NuxtLink",
  props: ["to"],
  template: '<a :href="to"><slot /></a>',
};

function mountLayout() {
  return mount(DefaultLayout, {
    global: { stubs: { NuxtLink: NuxtLinkStub } },
    slots: { default: "<div class='page-slot' />" },
  });
}

describe("default 布局导航", () => {
  it("五项导航全部落地真实路由，无占位项", () => {
    routeState.path = "/";
    const wrapper = mountLayout();
    const links = wrapper.findAll(".nav-item");
    const mapping = links.map((el) => ({ label: el.text(), href: el.attributes("href") }));
    expect(mapping).toEqual([
      { label: "行动中心", href: "/scheduler" },
      { label: "心智整备", href: "/agents" },
      { label: "自动委托", href: "/blueprints" },
      { label: "通讯中枢", href: "/hub" },
      { label: "广播站", href: "/changelog" },
    ]);
    // placeholder 机制已随全部占位落地删除
    expect(wrapper.find(".nav-item.placeholder").exists()).toBe(false);
  });

  it("导航仅首页常驻：/agents 下右栏与底栏均隐藏（既有口径不变）", () => {
    routeState.path = "/agents";
    const wrapper = mountLayout();
    expect(wrapper.find(".right-nav").exists()).toBe(false);
    expect(wrapper.find(".bottom-bar").exists()).toBe(false);
  });

  it("新目的地页不纳入顶层路径：/changelog 下右栏隐藏、底栏保留", () => {
    routeState.path = "/changelog";
    const wrapper = mountLayout();
    expect(wrapper.find(".right-nav").exists()).toBe(false);
    expect(wrapper.find(".bottom-bar").exists()).toBe(true);
  });
});

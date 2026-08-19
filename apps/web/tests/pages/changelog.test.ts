import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import ChangelogPage from "../../pages/changelog.vue";
import type { ChangelogEntry } from "@/content/changelog";

// 数据源可替换：mock 模块导出同一个数组引用，各用例在挂载前就地改内容
// （页面 setup 捕获的是引用，模板按数组序渲染）
const { entries } = vi.hoisted(() => ({ entries: [] as ChangelogEntry[] }));
vi.mock("@/content/changelog", () => ({ changelogEntries: entries }));

describe("changelog 更新日志页（广播站）", () => {
  beforeEach(() => {
    entries.length = 0;
    entries.push(
      { version: "未发布", date: "进行中", title: "新档主题", items: ["条目甲", "条目乙"] },
      { version: "2.0.0", date: "2026-08-17", title: "旧档主题", items: ["条目丙"] },
    );
  });

  it("按数据源顺序渲染条目（最新在前）", () => {
    const wrapper = mount(ChangelogPage);
    const cards = wrapper.findAll(".entry-card");
    expect(cards).toHaveLength(2);
    // 倒序契约：数组首项（最新）渲染在第一张卡片
    expect(wrapper.findAll(".entry-version").map((n) => n.text())).toEqual(["未发布", "2.0.0"]);
    expect(wrapper.findAll(".entry-date").map((n) => n.text())).toEqual(["进行中", "2026-08-17"]);
    expect(wrapper.findAll(".entry-title").map((n) => n.text())).toEqual(["新档主题", "旧档主题"]);
    // 条目逐条渲染
    expect(cards[0].findAll(".entry-items li").map((n) => n.text())).toEqual(["条目甲", "条目乙"]);
    expect(cards[1].findAll(".entry-items li").map((n) => n.text())).toEqual(["条目丙"]);
  });

  it("空数据源渲染空态，不出卡片", () => {
    entries.length = 0;
    const wrapper = mount(ChangelogPage);
    expect(wrapper.text()).toContain("暂无更新日志");
    expect(wrapper.findAll(".entry-card")).toHaveLength(0);
  });

  it("真实数据源：最新档为「未发布」且各档条目非空", async () => {
    const actual = await vi.importActual<typeof import("@/content/changelog")>("@/content/changelog");
    expect(actual.changelogEntries.length).toBeGreaterThan(0);
    expect(actual.changelogEntries[0].version).toBe("未发布");
    for (const entry of actual.changelogEntries) {
      expect(entry.date).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.items.length).toBeGreaterThan(0);
    }
  });
});

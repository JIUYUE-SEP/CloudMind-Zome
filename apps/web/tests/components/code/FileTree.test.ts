import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import FileTree, { type FileEntry } from "../../../components/code/FileTree.vue";

describe("FileTree", () => {
  const entries: FileEntry[] = [
    { name: "src", type: "directory" },
    { name: "index.ts", type: "file" },
    { name: "readme.md", type: "file" },
    { name: "link", type: "symlink" },
  ];

  it("renders file entries", () => {
    const wrapper = mount(FileTree, { props: { entries } });
    const names = wrapper.findAll(".entry-name").map((el) => el.text());
    expect(names).toEqual(["src", "index.ts", "readme.md", "link"]);
  });

  it("emits open event when an entry is clicked", async () => {
    const wrapper = mount(FileTree, { props: { entries } });
    await wrapper.findAll(".file-tree-entry")[1].trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
    expect(wrapper.emitted("open")?.[0]).toEqual([entries[1]]);
  });

  it("renders different icons for entry types", () => {
    const wrapper = mount(FileTree, { props: { entries } });
    const icons = wrapper.findAll(".entry-icon").map((el) => el.text());
    expect(icons[0]).toBe("📁");
    expect(icons[1]).toBe("📄");
    expect(icons[2]).toBe("📄");
    expect(icons[3]).toBe("🔗");
  });
});

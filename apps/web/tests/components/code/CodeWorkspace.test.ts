import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CodeWorkspace from "../../../components/code/CodeWorkspace.vue";
import type { FileEntry } from "../../../components/code/FileTree.vue";

vi.mock("@monaco-editor/loader", () => ({
  default: {
    init: vi.fn(() =>
      Promise.resolve({
        editor: {
          create: vi.fn(() => ({
            onDidChangeModelContent: vi.fn(),
            getValue: vi.fn(() => ""),
            setValue: vi.fn(),
            getModel: vi.fn(),
            dispose: vi.fn(),
          })),
          setModelLanguage: vi.fn(),
        },
      }),
    ),
  },
}));

describe("CodeWorkspace", () => {
  const entries: FileEntry[] = [
    { name: "src", type: "directory" },
    { name: "main.ts", type: "file" },
  ];

  it("renders sidebar, editor and terminal areas", () => {
    const wrapper = mount(CodeWorkspace, {
      props: { entries, terminalOutput: "" },
    });
    expect(wrapper.find(".workspace-sidebar").exists()).toBe(true);
    expect(wrapper.find(".editor-area").exists()).toBe(true);
    expect(wrapper.find(".terminal-area").exists()).toBe(true);
  });

  it("renders file tree entries", () => {
    const wrapper = mount(CodeWorkspace, {
      props: { entries, terminalOutput: "" },
    });
    const names = wrapper.findAll(".entry-name").map((el) => el.text());
    expect(names).toEqual(["src", "main.ts"]);
  });

  it("emits openFile when a file entry is clicked", async () => {
    const wrapper = mount(CodeWorkspace, {
      props: { entries, terminalOutput: "" },
    });
    await wrapper.findAll(".file-tree-entry")[1].trigger("click");
    expect(wrapper.emitted("openFile")).toHaveLength(1);
    expect(wrapper.emitted("openFile")?.[0]).toEqual(["main.ts"]);
  });

  it("does not emit openFile when a directory is clicked", async () => {
    const wrapper = mount(CodeWorkspace, {
      props: { entries, terminalOutput: "" },
    });
    await wrapper.findAll(".file-tree-entry")[0].trigger("click");
    expect(wrapper.emitted("openFile")).toBeUndefined();
  });

  it("emits clearTerminal when terminal clear button is clicked", async () => {
    const wrapper = mount(CodeWorkspace, {
      props: { entries, terminalOutput: "build done" },
    });
    await wrapper.find(".terminal-header button").trigger("click");
    expect(wrapper.emitted("clearTerminal")).toHaveLength(1);
  });

  it("passes current file content and path to editor", async () => {
    const wrapper = mount(CodeWorkspace, {
      props: {
        entries,
        terminalOutput: "",
        currentFileContent: "const x = 1;",
        currentFilePath: "main.ts",
      },
    });
    await flushPromises();
    expect(wrapper.find(".code-editor").exists()).toBe(true);
  });
});

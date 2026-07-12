import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CodeEditor from "../../../components/code/CodeEditor.vue";
import loader from "@monaco-editor/loader";

const mocks = vi.hoisted(() => {
  const modelDispose = vi.fn();
  const editorDispose = vi.fn();
  const setValue = vi.fn();
  const getValue = vi.fn(() => "");
  const getModel = vi.fn();
  const onDidChangeModelContent = vi.fn();
  const createModel = vi.fn(() => ({ dispose: modelDispose }));
  const create = vi.fn(() => ({
    onDidChangeModelContent,
    getValue,
    setValue,
    getModel,
    dispose: editorDispose,
  }));
  const setModelLanguage = vi.fn();

  return {
    modelDispose,
    editorDispose,
    setValue,
    getValue,
    getModel,
    onDidChangeModelContent,
    createModel,
    create,
    setModelLanguage,
  };
});

vi.mock("@monaco-editor/loader", () => ({
  default: {
    init: vi.fn(() =>
      Promise.resolve({
        editor: {
          create: mocks.create,
          createModel: mocks.createModel,
          setModelLanguage: mocks.setModelLanguage,
        },
      }),
    ),
  },
}));

describe("CodeEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getValue.mockReturnValue("");
  });

  it("calls loader.init and creates editor/model after mount", async () => {
    mount(CodeEditor, {
      props: { modelValue: "hello", path: "main.ts" },
    });

    expect(loader.init).toHaveBeenCalledOnce();

    await flushPromises();

    expect(mocks.createModel).toHaveBeenCalledOnce();
    expect(mocks.createModel).toHaveBeenCalledWith("hello", "typescript");
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.onDidChangeModelContent).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });

  it("emits update:modelValue when editor content changes", async () => {
    const wrapper = mount(CodeEditor, {
      props: { modelValue: "hello", path: "main.ts" },
    });
    await flushPromises();

    mocks.getValue.mockReturnValue("changed");
    const changeHandler = mocks.onDidChangeModelContent.mock.calls[0][0] as () => void;
    changeHandler();

    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["changed"]);
  });

  it("calls setValue when modelValue prop changes", async () => {
    const wrapper = mount(CodeEditor, {
      props: { modelValue: "initial", path: "main.ts" },
    });
    await flushPromises();

    await wrapper.setProps({ modelValue: "updated" });

    expect(mocks.setValue).toHaveBeenCalledWith("updated");
  });

  it("disposes editor and model on unmount", async () => {
    const wrapper = mount(CodeEditor, {
      props: { modelValue: "initial", path: "main.ts" },
    });
    await flushPromises();

    wrapper.unmount();

    expect(mocks.editorDispose).toHaveBeenCalledOnce();
    expect(mocks.modelDispose).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import LogPanel from "../../components/LogPanel.vue";

describe("LogPanel 拖拽清理", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("卸载时移除 document 监听并恢复 body userSelect", async () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const wrapper = mount(LogPanel, { props: { visible: true } });

    // 在标题栏按下开始拖拽：注册 document 监听并禁选
    await wrapper.find(".log-title").trigger("mousedown");
    expect(document.body.style.userSelect).toBe("none");

    wrapper.unmount();

    expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("mouseup", expect.any(Function));
    expect(document.body.style.userSelect).toBe("");
  });

  it("正常 mouseup 后清理，卸载不残留", async () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const wrapper = mount(LogPanel, { props: { visible: true } });

    await wrapper.find(".log-title").trigger("mousedown");
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.body.style.userSelect).toBe("");

    wrapper.unmount();
    // mouseup 与卸载各清理一次，均为幂等
    expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function));
  });
});

import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import TerminalPanel from "../../../components/code/TerminalPanel.vue";

describe("TerminalPanel", () => {
  it("renders terminal output", () => {
    const wrapper = mount(TerminalPanel, {
      props: { output: "hello world\nline two" },
    });
    expect(wrapper.find(".terminal-content code").text()).toContain("hello world");
    expect(wrapper.find(".terminal-content code").text()).toContain("line two");
  });

  it("emits clear event when clear button is clicked", async () => {
    const wrapper = mount(TerminalPanel, {
      props: { output: "some output" },
    });
    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("clear")).toHaveLength(1);
  });

  it("displays terminal header", () => {
    const wrapper = mount(TerminalPanel, { props: { output: "" } });
    expect(wrapper.find(".terminal-header").text()).toContain("Terminal");
  });
});

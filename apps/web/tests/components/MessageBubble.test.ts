import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MessageBubble from "../../components/MessageBubble.vue";

describe("MessageBubble", () => {
  it("renders user text", () => {
    const wrapper = mount(MessageBubble, {
      props: { role: "user", text: "hi" },
    });
    expect(wrapper.text()).toContain("hi");
    expect(wrapper.classes()).toContain("role-user");
  });

  it("renders thinking block", () => {
    const wrapper = mount(MessageBubble, {
      props: { role: "assistant", text: "ok", thinking: "deep thought" },
    });
    expect(wrapper.text()).toContain("思考过程");
    expect(wrapper.text()).toContain("deep thought");
  });

  it("renders tool calls", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        toolCalls: [{ toolCallId: "t1", name: "search", arguments: { q: "x" } }],
      },
    });
    expect(wrapper.text()).toContain("search");
  });
});

import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MessageBubble from "../../components/MessageBubble.vue";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("MessageBubble", () => {
  it("纯文本：渲染正文，无思考块和工具卡片", () => {
    const wrapper = mount(MessageBubble, {
      props: { role: "user", text: "hi" },
    });
    expect(wrapper.text()).toContain("hi");
    expect(wrapper.classes()).toContain("role-user");
    expect(wrapper.find(".thinking-block").exists()).toBe(false);
    expect(wrapper.find(".tool-card").exists()).toBe(false);
    expect(wrapper.find(".cursor").exists()).toBe(false);
  });

  it("带思考：折叠块默认收起，展开后可见思考内容", async () => {
    const wrapper = mount(MessageBubble, {
      props: { role: "assistant", text: "ok", thinking: "deep thought" },
    });
    const details = wrapper.find(".thinking-block");
    expect(details.exists()).toBe(true);
    // 默认折叠
    expect(details.attributes("open")).toBeUndefined();
    expect(wrapper.find(".thinking-body").text()).toBe("deep thought");
    // 点击 summary 展开
    await wrapper.find(".thinking-summary").trigger("click");
    expect(details.attributes("open")).toBeDefined();
  });

  it("带工具调用：卡片显示工具名、格式化 JSON 参数与完成状态", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        toolCalls: [{ toolCallId: "t1", name: "search", arguments: { q: "x" } }],
      },
    });
    const card = wrapper.find(".tool-card");
    expect(card.exists()).toBe(true);
    // 完成态默认收起：摘要行（图标+名称+状态 pill）可见，详情折叠
    expect(card.attributes("open")).toBeUndefined();
    const summary = wrapper.find(".tool-summary");
    expect(summary.text()).toContain("search");
    expect(summary.text()).toContain("已完成");
    expect(wrapper.find(".tool-args").text()).toContain('"q": "x"');
    expect(card.classes()).toContain("tool-done");
  });

  it("工具卡片默认收起：点击展开显示 JSON，再点收起", async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "send_private_message",
            arguments: { to: "a2", content: "长信正文".repeat(100) },
          },
        ],
      },
    });
    const details = wrapper.find(".tool-card");
    const summary = wrapper.find(".tool-summary");

    // 默认收起：只显示摘要行，JSON 详情不展开
    expect(details.attributes("open")).toBeUndefined();
    expect(summary.text()).toContain("send_private_message");
    expect(summary.text()).toContain("已完成");

    await summary.trigger("click");
    expect(details.attributes("open")).toBeDefined();
    expect(wrapper.find(".tool-args").text()).toContain('"to": "a2"');

    await summary.trigger("click");
    expect(details.attributes("open")).toBeUndefined();
  });

  it("进行中的工具调用：默认展开显示 JSON，状态 pill 显示执行中", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        isStreaming: true,
        toolCalls: [{ toolCallId: "t1", name: "bash", arguments: { cmd: "ls" } }],
      },
    });
    const card = wrapper.find(".tool-card");
    expect(card.attributes("open")).toBeDefined();
    expect(wrapper.find(".tool-badge").text()).toBe("执行中");
    expect(wrapper.find(".tool-args").text()).toContain('"cmd": "ls"');
    expect(card.classes()).toContain("tool-running");
  });

  it("审批中的工具调用高亮显示", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        isStreaming: true,
        toolCalls: [{ toolCallId: "t1", name: "bash", arguments: {}, status: "awaiting-approval" as const }],
      },
    });
    const card = wrapper.find(".tool-card");
    expect(card.classes()).toContain("tool-awaiting-approval");
    expect(wrapper.find(".tool-badge").text()).toBe("等待审批");
  });

  it("流式中：显示光标，打字机从 0 开始逐渐追赶到全文", async () => {
    const wrapper = mount(MessageBubble, {
      props: { role: "assistant", text: "hello streaming world", isStreaming: true },
    });
    expect(wrapper.find(".cursor").exists()).toBe(true);
    // 初始几乎为空（打字机起点），随后 rAF 追赶
    const initialLen = wrapper.find(".message-text").text().length;
    expect(initialLen).toBeLessThan("hello streaming world".length);
    await sleep(300);
    expect(wrapper.find(".message-text").text()).toContain("hello streaming world");
  });

  it("非流式：立即显示全文，无光标", () => {
    const wrapper = mount(MessageBubble, {
      props: { role: "assistant", text: "full text", isStreaming: false },
    });
    expect(wrapper.find(".message-text").text()).toBe("full text");
    expect(wrapper.find(".cursor").exists()).toBe(false);
  });

  it("流式思考中显示「正在思考…」，非流式后保留完整内容可展开", async () => {
    const wrapper = mount(MessageBubble, {
      props: { role: "assistant", text: "", thinking: "思考中", isStreaming: true },
    });
    expect(wrapper.find(".thinking-hint").text()).toBe("正在思考…");
    expect(wrapper.find(".thinking-dots").exists()).toBe(true);

    await wrapper.setProps({ isStreaming: false });
    expect(wrapper.find(".thinking-hint").exists()).toBe(false);
    expect(wrapper.find(".thinking-dots").exists()).toBe(false);

    const details = wrapper.find(".thinking-block");
    expect(details.exists()).toBe(true);
    expect(wrapper.find(".thinking-body").text()).toBe("思考中");
    expect(details.attributes("open")).toBeUndefined();
    await wrapper.find(".thinking-summary").trigger("click");
    expect(details.attributes("open")).toBeDefined();
  });
});

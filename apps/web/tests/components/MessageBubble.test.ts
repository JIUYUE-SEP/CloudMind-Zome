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

  it("generate_image persisted:true：渲染 img，src 经 /api/agent-file 代理拼接，meta 显示 model·size", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        agentId: "a1",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "generate_image",
            arguments: { prompt: "a cat" },
            output: { path: "files/images/20260826-061100-a1b2c3.png", model: "gpt-image-1", size: "1024x1024", persisted: true },
          },
        ],
      },
    });
    const img = wrapper.find(".tool-image");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe(
      `/api/agent-file?agentId=a1&path=${encodeURIComponent("files/images/20260826-061100-a1b2c3.png")}`,
    );
    expect(wrapper.find(".tool-image-meta").text()).toBe("gpt-image-1 · 1024x1024");
    expect(wrapper.find(".tool-image-fallback").exists()).toBe(false);
  });

  it("generate_image persisted:true 但缺 agentId：退化为路径文本，不渲染 img", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "generate_image",
            arguments: {},
            output: { path: "files/images/x.png", persisted: true },
          },
        ],
      },
    });
    expect(wrapper.find(".tool-image").exists()).toBe(false);
    expect(wrapper.find(".tool-image-fallback").text()).toContain("files/images/x.png");
    // model/size 缺省（undefined）：meta 行不渲染
    expect(wrapper.find(".tool-image-meta").exists()).toBe(false);
  });

  it("generate_image 图片加载失败：img 退场，退化为路径文本兜底", async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        agentId: "a1",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "generate_image",
            arguments: {},
            output: { path: "files/images/x.png", persisted: true },
          },
        ],
      },
    });
    await wrapper.find(".tool-image").trigger("error");
    expect(wrapper.find(".tool-image").exists()).toBe(false);
    expect(wrapper.find(".tool-image-fallback").text()).toContain("files/images/x.png");
  });

  it("generate_image persisted:false：渲染 sourceUrl 外链 + note，不渲染 img", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        agentId: "a1",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "generate_image",
            arguments: {},
            output: {
              persisted: false,
              sourceUrl: "https://img.example.com/r.png",
              note: "图片下载失败（HTTP 500），未落盘；sourceUrl 可能有时效",
            },
          },
        ],
      },
    });
    expect(wrapper.find(".tool-image").exists()).toBe(false);
    const link = wrapper.find(".tool-image-link");
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("https://img.example.com/r.png");
    expect(link.attributes("target")).toBe("_blank");
    expect(wrapper.find(".tool-image-note").text()).toContain("HTTP 500");
  });

  it("generate_image 整壳真形状（ToolResult {success,output}，与 tool.result 帧一致）：拆壳后渲染 img", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        agentId: "a1",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "generate_image",
            arguments: { prompt: "a cat" },
            // engine tool-call.ts 把 execute 返回的整个 ToolResult 透传进帧：
            // output = { success: true, output: { path, persisted, ... } }
            output: { success: true, output: { path: "files/images/x.png", persisted: true } },
          },
        ],
      },
    });
    const img = wrapper.find(".tool-image");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe(
      `/api/agent-file?agentId=a1&path=${encodeURIComponent("files/images/x.png")}`,
    );
  });

  it("generate_image persisted:false 但 sourceUrl 非 http(s)：不渲染链接，退化为纯文本", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        agentId: "a1",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "generate_image",
            arguments: {},
            output: { persisted: false, sourceUrl: "javascript:alert(1)", note: "n" },
          },
        ],
      },
    });
    expect(wrapper.find(".tool-image-link").exists()).toBe(false);
    expect(wrapper.find(".tool-image-fallback").text()).toContain("javascript:alert(1)");
    expect(wrapper.find(".tool-image-note").text()).toBe("n");
  });

  it("非 generate_image 形状的 output：不渲染图片结果块", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: "assistant",
        text: "",
        agentId: "a1",
        toolCalls: [
          {
            toolCallId: "t1",
            name: "web_search",
            arguments: {},
            output: { results: [{ title: "t", url: "u", content: "c" }] },
          },
        ],
      },
    });
    expect(wrapper.find(".tool-image-result").exists()).toBe(false);
  });
});

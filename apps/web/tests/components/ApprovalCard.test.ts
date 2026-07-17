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

  it("truncates overly long args", () => {
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, args: { data: "a".repeat(500) } },
    });
    const text = wrapper.find(".approval-args").text();
    expect(text.length).toBeLessThan(400);
    expect(text.endsWith("…")).toBe(true);
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
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, toolName: "edit_file", args: { path: "a.ts" } },
    });
    const btn = wrapper.findAll("button").find((b) => b.text() === "本会话不再询问");
    await btn!.trigger("click");
    expect(wrapper.emitted("respond")).toEqual([
      [{ approvalId: "ap-1", approved: true, remember: true }],
    ]);
  });

  it("disables remember with hint for run_command (每次都必须确认)", async () => {
    const wrapper = mount(ApprovalCard, { props: baseProps }); // toolName: run_command
    const btn = wrapper.findAll("button").find((b) => b.text() === "本会话不再询问");
    expect(btn!.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("该工具每次都需要确认");
    await btn!.trigger("click");
    expect(wrapper.emitted("respond")).toBeUndefined();
  });

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

  it("shows expired status for timed-out card", () => {
    const wrapper = mount(ApprovalCard, {
      props: { ...baseProps, status: "expired" as const },
    });
    expect(wrapper.text()).toContain("已超时或已处理");
  });
});

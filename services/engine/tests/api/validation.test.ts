import { describe, it, expect, vi } from "vitest";
import { isApprovalRememberable, sanitizeDeltaEvent } from "../../src/api/ws/validation.js";

describe("isApprovalRememberable", () => {
  it("run_command 不允许 remember（裸 shell，remember 一次等于本连接放行一切命令）", () => {
    expect(isApprovalRememberable("run_command")).toBe(false);
  });

  it.each(["edit_file", "write_file", "bash", "dispatch_subagent"])(
    "其他危险工具允许 remember: %s",
    (toolName) => {
      expect(isApprovalRememberable(toolName)).toBe(true);
    },
  );
});

describe("sanitizeDeltaEvent", () => {
  it("string delta 帧原样放行", () => {
    const event = { type: "text.delta", delta: "hello" };
    expect(sanitizeDeltaEvent(event)).toBe(event);
  });

  it("不带 delta 字段的帧原样放行", () => {
    const event = { type: "step.end", finishReason: "stop" };
    expect(sanitizeDeltaEvent(event)).toBe(event);
  });

  it.each([undefined, null, 42, { text: "x" }, ["x"]])(
    "非 string 的 delta 丢弃并打 warn: %j",
    (badDelta) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const event = { type: "text.delta", delta: badDelta };
      expect(sanitizeDeltaEvent(event)).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    },
  );
});

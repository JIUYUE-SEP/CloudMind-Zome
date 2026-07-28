import { logger } from "../../src/logger.js";
import { describe, it, expect, vi } from "vitest";
import { isApprovalRememberable, sanitizeDeltaEvent } from "../../src/api/ws/validation.js";

describe("isApprovalRememberable", () => {
  it.each(["run_command", "write_file", "edit_file", "dispatch_subagent"])(
    "写类/裸 shell/派生工具不允许 remember（P2-3/P2-5：注入落地路径，一律每次批）: %s",
    (toolName) => {
      expect(isApprovalRememberable(toolName)).toBe(false);
    },
  );

  it.each(["bash"])("其他危险工具允许 remember: %s", (toolName) => {
    expect(isApprovalRememberable(toolName)).toBe(true);
  });
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
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const event = { type: "text.delta", delta: badDelta };
      expect(sanitizeDeltaEvent(event)).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    },
  );
});

import { describe, it, expect } from "vitest";
import { isApprovalRememberable } from "../../src/api/ws/validation.js";

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

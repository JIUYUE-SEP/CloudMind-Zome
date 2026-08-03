import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "../../src/logger.js";
import {
  summarizeArgs,
  auditRequest,
  auditDecision,
  auditTimeout,
  auditRemembered,
  auditRememberRejected,
  auditAutoApproved,
  auditTrustedAutoApprove,
  auditFailClosed,
} from "../../src/api/ws/approval-audit.js";

describe("summarizeArgs 审计参摘要（P4-3）", () => {
  it("path 全文保留（审计定位关键）", () => {
    expect(summarizeArgs("write_file", { path: "docs/a.md", content: "x".repeat(5000) })).toBe(
      "path=docs/a.md",
    );
  });

  it("command 截 500 并标注原长", () => {
    const cmd = "echo " + "y".repeat(600);
    const out = summarizeArgs("run_command", { command: cmd });
    expect(out.startsWith("command=echo ")).toBe(true);
    expect(out.length).toBeLessThan(cmd.length);
    expect(out).toContain("chars)");
  });

  it("dispatch_subagent：目标 agent 全文 + task 截 300", () => {
    const out = summarizeArgs("dispatch_subagent", { agentId: "a2", task: "t".repeat(400) });
    expect(out).toContain("agentId=a2");
    expect(out).toContain("chars)");
  });

  it("其他参数 JSON 截 300；非对象参数直接截断", () => {
    expect(summarizeArgs("custom", { a: "b".repeat(400) })).toContain("chars)");
    expect(summarizeArgs("custom", "plain")).toBe('"plain"');
  });
});

describe("审批审计事件（P4-3）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("请求/批准/拒绝/超时/免问记入/免问被拒/免问命中/信任放行/fail-closed 各有结构化日志", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const base = { agentId: "a1", sessionId: "s1", toolName: "write_file" };

    auditRequest({ ...base, approvalId: "ap-1", toolCallId: "tc-1", args: { path: "x.md" } });
    auditDecision({ ...base, approvalId: "ap-1", approved: true });
    auditDecision({ ...base, approvalId: "ap-2", approved: false });
    auditTimeout({ ...base, approvalId: "ap-3" });
    auditRemembered(base);
    auditRememberRejected(base);
    auditAutoApproved(base);
    auditTrustedAutoApprove({ ...base, toolCallId: "tc-trust", args: { command: "rm -rf x" } });
    auditFailClosed({ agentId: "a1", toolName: "run_command", toolCallId: "tc-9" });

    const infoMsgs = info.mock.calls.map((c) => c[1]);
    expect(infoMsgs).toEqual(
      expect.arrayContaining([
        "[approval] 请求审批",
        "[approval] 批准",
        "[approval] 拒绝",
        "[approval] 免问名单命中，自动放行",
        "[approval] 信任模式自动放行",
      ]),
    );
    const warnMsgs = warn.mock.calls.map((c) => c[1]);
    expect(warnMsgs).toEqual(
      expect.arrayContaining([
        "[approval] 审批超时按拒绝处理",
        "[approval] 记入本会话免问名单",
        "[approval] remember 被引擎拒绝（该工具每次必批）",
        "[approval] 无审批通道，fail-closed 拒绝",
      ]),
    );

    // 够审计的字段：谁（agent/session）、什么工具、什么参数摘要、哪个审批
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        sessionId: "s1",
        toolName: "write_file",
        approvalId: "ap-1",
        toolCallId: "tc-1",
        args: "path=x.md",
      }),
      "[approval] 请求审批",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "a1", toolName: "run_command", toolCallId: "tc-9" }),
      "[approval] 无审批通道，fail-closed 拒绝",
    );
    // 信任放行：工具名 + 参数摘要（沿用既有脱敏：command 截 500）
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        sessionId: "s1",
        toolName: "write_file",
        toolCallId: "tc-trust",
        args: "command=rm -rf x",
      }),
      "[approval] 信任模式自动放行",
    );
  });
});

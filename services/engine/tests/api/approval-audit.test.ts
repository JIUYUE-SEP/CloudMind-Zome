import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "../../src/logger.js";
import { restoreDataDir } from "../helpers/env.js";
import { DocumentStore } from "../../src/plugins/memory/document-store.js";
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
} from "../../src/plugins/approval-audit/index.js";

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
  // 本组只测 logger 结构化日志：M34 文件 sink 在此 mock 掉（落盘由下方 M34 组专测），
  // 否则 fire-and-forget 写盘与 afterEach 的目录清理竞态（ENOTEMPTY）
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "approval-audit-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    vi.spyOn(DocumentStore.prototype, "appendLine").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

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
      ]),
    );
    const warnMsgs = warn.mock.calls.map((c) => c[1]);
    expect(warnMsgs).toEqual(
      expect.arrayContaining([
        "[approval] 审批超时按拒绝处理",
        "[approval] 记入本会话免问名单",
        "[approval] remember 被引擎拒绝（该工具每次必批）",
        "[approval] 信任模式自动放行",
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
    // 信任放行：warn 级，工具名 + 参数摘要（沿用既有脱敏：command 截 500）
    expect(warn).toHaveBeenCalledWith(
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

describe("M34 文件 sink：approval-audit.jsonl 跨重启留存", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "approval-audit-sink-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const jsonlPath = () => path.join(tmpDir, "approval-audit.jsonl");

  async function readJsonl(): Promise<Record<string, unknown>[]> {
    const content = await fs.readFile(jsonlPath(), "utf-8").catch(() => "");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("审批事件落行：ts/event/主体字段/args 摘要/schemaVersion 齐全", async () => {
    auditRequest({
      agentId: "a1",
      sessionId: "s1",
      toolName: "write_file",
      approvalId: "ap-1",
      toolCallId: "tc-1",
      args: { path: "docs/a.md", content: "x".repeat(5000) },
    });
    auditDecision({ agentId: "a1", sessionId: "s1", toolName: "write_file", approvalId: "ap-1", approved: true });
    auditFailClosed({ agentId: "a2", toolName: "run_command", toolCallId: "tc-9" });

    // fire-and-forget 落盘：轮询等写队列落定（3 行到齐）
    await vi.waitFor(async () => expect(await readJsonl()).toHaveLength(3));

    const [req, dec, fc] = await readJsonl();
    // 请求：事件名 + 主体字段 + args 走摘要脱敏（不落 content 原文）
    expect(req).toMatchObject({
      event: "request",
      agentId: "a1",
      sessionId: "s1",
      toolName: "write_file",
      approvalId: "ap-1",
      toolCallId: "tc-1",
      args: "path=docs/a.md",
    });
    expect(typeof req.ts).toBe("string");
    expect(req.schemaVersion).toBe(1);
    expect(JSON.stringify(req)).not.toContain("x".repeat(100));
    // 决策：approved 结果落行
    expect(dec).toMatchObject({ event: "decision", approvalId: "ap-1", approved: true });
    // fail-closed：无 sessionId 字段
    expect(fc).toMatchObject({ event: "fail-closed", agentId: "a2", toolName: "run_command", toolCallId: "tc-9" });
    expect(fc).not.toHaveProperty("sessionId");
  });

  it("写失败仅 warn 落盘失败，不影响审批决策（不炸审批链路）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(DocumentStore.prototype, "appendLine").mockRejectedValue(new Error("disk full"));

    // 调用本身同步不抛（fire-and-forget）
    expect(() =>
      auditDecision({ agentId: "a1", sessionId: "s1", toolName: "write_file", approvalId: "ap-1", approved: false }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "decision" }),
        "[approval] 审计事件落盘失败（审批链路不受影响）",
      );
    });
  });
});

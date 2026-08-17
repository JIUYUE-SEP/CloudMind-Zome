import { describe, it, expect } from "vitest";
import {
  APPROVAL_TIMEOUT_MS,
  createApprovalMessage,
  settleApproval,
  expireApproval,
  expireAllPendingApprovals,
} from "@/utils/approval";

function pendingCard(approvalId: string, toolCallId = "t1") {
  return createApprovalMessage({ approvalId, toolCallId, toolName: "run_command", arguments: {} });
}

describe("approval 超时/断线失效（M44）", () => {
  it("APPROVAL_TIMEOUT_MS 与 engine 的 60s 审批超时对齐", () => {
    expect(APPROVAL_TIMEOUT_MS).toBe(60_000);
  });

  it("expireApproval 把指定 pending 卡片标为 expired，已处理卡片不受影响且幂等", () => {
    const msgs = [pendingCard("ap1"), pendingCard("ap2")];
    settleApproval(msgs, "ap2", "approved");

    expireApproval(msgs, "ap1");
    expect(msgs[0]!.approval.status).toBe("expired");
    expect(msgs[1]!.approval.status).toBe("approved");

    // 重复调用/未知 id 不炸、不改状态
    expireApproval(msgs, "ap1");
    expireApproval(msgs, "ap-unknown");
    expect(msgs[0]!.approval.status).toBe("expired");
  });

  it("expireAllPendingApprovals 只把 pending 卡片标为 expired", () => {
    const msgs = [pendingCard("ap1"), pendingCard("ap2"), pendingCard("ap3")];
    settleApproval(msgs, "ap2", "denied");
    expireApproval(msgs, "ap3");

    expireAllPendingApprovals(msgs);
    expect(msgs.map((m) => m.approval.status)).toEqual(["expired", "denied", "expired"]);
  });
});

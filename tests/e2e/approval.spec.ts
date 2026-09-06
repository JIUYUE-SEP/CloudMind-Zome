import { test, expect } from "@playwright/test";
import { createAgentViaRest, injectToolCalls } from "./utils.js";

test.describe("审批流（注入链）", () => {
  test("注入 run_command → 审批卡片 → 批准 → 工具执行与状态翻转", async ({ page, request }) => {
    const agentId = `e2e-approval-${Date.now()}`;
    const agentName = "E2E Approval";
    // UI 创建默认 tools:[]（白名单空=无内置工具）——审批用例必须显式给白名单
    await createAgentViaRest(request, { id: agentId, name: agentName, tools: ["run_command"] });

    await page.goto("/hub");
    await page.locator(".comm-item", { hasText: agentName }).click();
    await expect(page.locator(".status")).toContainText("已连接");

    await injectToolCalls(request, agentId, [
      { toolCallId: "tc1", name: "run_command", arguments: { command: "echo e2e-ok" } },
    ]);
    await page.fill('input[placeholder="输入消息..."]', "跑一下");
    await page.click('button:has-text("发送")');

    // 审批卡片出现：工具名 + 批准/拒绝按钮
    const card = page.locator(".approval-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("run_command");

    // 批准 → 卡片状态翻转 approved
    await card.locator("button.approve").click();
    await expect(card).toHaveClass(/status-approved/);

    // 工具执行结果帧 + 后续 assistant 文本（Mock 第二段回复）
    await expect(page.locator(".message-bubble").last()).toContainText("mock");
  });
});

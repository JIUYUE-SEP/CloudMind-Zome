import { test, expect } from "@playwright/test";
import { createAgentViaRest } from "./utils.js";

test.describe("单/多模式切换", () => {
  test("切单 → 选择器选人直达私聊 → 刷新保持（localStorage 持久）", async ({ page, request }) => {
    const agentId = `e2e-mode-${Date.now()}`;
    const agentName = "E2E Mode";
    await createAgentViaRest(request, { id: agentId, name: agentName });

    await page.goto("/hub");
    // 切单模式
    await page.locator(".agent-mode-switch .comm-mode-btn", { hasText: "单" }).click();
    // 选择器选人 → 直达私聊
    await page.locator(".single-agent-select").selectOption(agentId);
    await expect(page.locator(".chat-view")).toBeVisible();
    await expect(page.locator(".status")).toContainText("已连接");

    // localStorage 已持久化
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("cloudmind.agentMode")))
      .toBe("single");
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("cloudmind.singleAgentId")))
      .toBe(agentId);

    // 刷新：单模式保持 + 选择器仍选中 + 仍直达私聊（名录到达后）
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".agent-mode-switch .comm-mode-btn.active")).toHaveText("单");
    await expect(page.locator(".single-agent-select")).toHaveValue(agentId);
    await expect(page.locator(".chat-view")).toBeVisible();
  });
});

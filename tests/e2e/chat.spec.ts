import { test, expect } from "@playwright/test";
import { createAgent } from "./utils.js";

test.describe("Chat flow", () => {
  test("user creates an agent and sends a message", async ({ page }) => {
    const agentId = `e2e-agent-${Date.now()}`;
    const agentName = "E2E Agent";
    await createAgent(page, agentId, agentName);

    // 回到通讯中枢，选择刚创建的心智开始私聊
    await page.goto("/hub");
    await page.locator(".comm-item", { hasText: agentName }).click();
    await expect(page.locator(".chat-view")).toBeVisible();

    // Wait for the WebSocket to connect before sending.
    await expect(page.locator(".status")).toContainText("已连接");

    // Send a message.
    await page.fill('input[placeholder="输入消息..."]', "hello");
    await page.click('button:has-text("发送")');

    // Wait for the assistant response (2 bubbles: user + assistant).
    await expect(page.locator(".message-bubble")).toHaveCount(2);
    const lastMessage = page.locator(".message-bubble").last();
    await expect(lastMessage).toContainText("mock");
  });
});

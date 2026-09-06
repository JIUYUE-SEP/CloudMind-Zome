import { test, expect } from "@playwright/test";
import { createAgentViaRest, injectToolCalls } from "./utils.js";

test.describe("生图工具卡（注入链，翻案单）", () => {
  test("注入 generate_image → 批准 → Mock 图落盘 → 工具卡 img 渲染", async ({ page, request }) => {
    const agentId = `e2e-image-${Date.now()}`;
    const agentName = "E2E Image";
    await createAgentViaRest(request, { id: agentId, name: agentName, tools: ["generate_image"] });

    await page.goto("/hub");
    await page.locator(".comm-item", { hasText: agentName }).click();
    await expect(page.locator(".status")).toContainText("已连接");

    await injectToolCalls(request, agentId, [
      { toolCallId: "tc1", name: "generate_image", arguments: { prompt: "a mock cat" } },
    ]);
    await page.fill('input[placeholder="输入消息..."]', "画一张");
    await page.click('button:has-text("发送")');

    // 审批卡片 → 批准
    const card = page.locator(".approval-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("generate_image");
    await card.locator("button.approve").click();
    await expect(card).toHaveClass(/status-approved/);

    // 工具卡出图：Mock provider 返 data-url（e2e）→ 解码落盘 persisted:true →
    // img 经 nuxt 代理取流（src 含 /api/agent-file 与 files/images 路径编码）
    const img = page.locator(".tool-image");
    await expect(img).toBeVisible();
    const src = await img.getAttribute("src");
    expect(src).toContain("/api/agent-file");
    expect(src).toContain(encodeURIComponent("files/images/"));
    expect(src).toContain(`.png`);
    // agentId 经会话上下文正确带入
    expect(src).toContain(`agentId=${agentId}`);
  });
});

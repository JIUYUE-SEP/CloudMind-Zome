import { test, expect } from "@playwright/test";
import { createAgentViaRest, ENGINE, ENGINE_TOKEN } from "./utils.js";

test.describe("群聊 @mention 路由", () => {
  test("两 agent 群聊 @a：a 回 b 不回（现状精确路由口径）", async ({ page, request }) => {
    const stamp = Date.now();
    const aId = `e2e-grp-a-${stamp}`;
    const bId = `e2e-grp-b-${stamp}`;
    await createAgentViaRest(request, { id: aId, name: "GrpAlice" });
    await createAgentViaRest(request, { id: bId, name: "GrpBeta" });

    // REST 建群（两成员）
    const sessionRes = await request.post(`${ENGINE}/sessions`, {
      headers: { authorization: `Bearer ${ENGINE_TOKEN}`, "content-type": "application/json" },
      data: { name: "E2E 群", agentIds: [aId, bId], type: "group" },
    });
    expect(sessionRes.ok()).toBe(true);

    await page.goto("/hub");
    // 群聊 tab → 选中群
    await page.locator(".comm-mode-btn", { hasText: "群聊" }).click();
    await page.locator(".comm-item", { hasText: "E2E 群" }).click();

    // @Alice 发消息：Mock 回应只应来自 Alice（精确路由），Beta 不说话
    await page.fill('input[placeholder="输入消息..."]', "@GrpAlice 在吗");
    await page.click('button:has-text("发送")');

    // Alice 的回复（speaker 标签 @GrpAlice + Mock 文本）
    await expect(page.locator(".speaker", { hasText: "@GrpAlice" })).toBeVisible();
    await expect(page.locator(".message-bubble", { hasText: "mock" }).first()).toBeVisible();
    // Beta 静默：不允许出现 Beta 的 speaker 标签
    await expect(page.locator(".speaker", { hasText: "@GrpBeta" })).toHaveCount(0);
  });
});

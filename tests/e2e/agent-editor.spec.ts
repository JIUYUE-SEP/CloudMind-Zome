import { test, expect } from "@playwright/test";
import { createAgent } from "./utils.js";

test.describe("Agent 编辑器", () => {
  test("改 persona 保存 → 重开页面持久", async ({ page }) => {
    const agentId = `e2e-editor-${Date.now()}`;
    const agentName = "E2E Editor";
    // createAgent 落在 /agents/:id/edit（编辑器现场）
    await createAgent(page, agentId, agentName);

    // 改 persona 保存
    const personaText = "E2E 人格：冷静、寡言、只说实话。";
    const textarea = page.locator("textarea").first();
    await textarea.fill(personaText);
    await page.locator(".save-btn").click();
    // 保存成功反馈（按编辑器现状等待可断言行/状态）
    await page.waitForTimeout(500);

    // 重开编辑器：值持久
    await page.goto(`/agents/${agentId}/edit`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("textarea").first()).toHaveValue(personaText);
  });
});

import { test, expect } from "@playwright/test";
import { createAgentViaRest } from "./utils.js";

test.describe("设置子页面 /settings/tools", () => {
  test("三清单渲染：内置「常驻」徽标 + 无动态工具空态", async ({ page, request }) => {
    const agentId = `e2e-tools-${Date.now()}`;
    await createAgentViaRest(request, { id: agentId, name: "E2E Tools" });

    await page.goto("/settings/tools");
    await page.waitForLoadState("networkidle");

    // 三节标题在场
    await expect(page.locator("h3", { hasText: "MCP 工具" })).toBeVisible();
    await expect(page.locator("h3", { hasText: "Skills" })).toBeVisible();
    await expect(page.locator("h3", { hasText: "内置工具" })).toBeVisible();

    // 无动态工具空态（e2e 环境 agent 无 mcp__/ext__ 工具）
    await expect(page.locator("text=该 Agent 暂无动态工具")).toBeVisible();

    // 内置工具节：15 行 + 全部「常驻」徽标，只读（无编辑按钮）
    const builtinRows = page.locator("ul.rows li", { has: page.locator(".badge-core") });
    await expect(builtinRows).toHaveCount(15);
    await expect(page.locator(".badge-core").first()).toHaveText("常驻");
    await expect(page.locator(".rows li .edit-btn").first()).toHaveCount(0);
  });
});

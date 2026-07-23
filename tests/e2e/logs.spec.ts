import { test, expect } from "@playwright/test";

test.describe("LogPanel", () => {
  test("shows real engine logs from GET /logs", async ({ page }) => {
    // engine 侧 /logs 必须已有缓冲日志（fastify 每个请求都会打 pino 日志）
    // engine 本地 token 鉴权（P0-2）：e2e token 由 scripts/start-e2e.mjs 固定注入
    const res = await page.request.get("http://127.0.0.1:8848/logs", {
      headers: { Authorization: "Bearer e2e-test-token" },
    });
    expect(res.ok()).toBeTruthy();
    const entries = (await res.json()) as { time: number; level: number; msg: string }[];
    expect(entries.length).toBeGreaterThan(0);

    // 首页打开日志面板，应渲染真实日志而不是假数据
    await page.goto("/");
    // 等客户端水合完成（subtitle 是 onMounted 后才填充的），否则点击会丢在水合前
    await expect(page.locator(".subtitle")).not.toBeEmpty();
    await page.locator(".log-btn").click();
    await expect(page.locator(".log-panel")).toBeVisible();
    await expect(page.locator(".log-item").first()).toBeVisible();
    // 级别列来自真实 pino level（INFO/WARN/ERROR/DEBUG/FATAL），message 非空
    await expect(page.locator(".log-source").first()).toContainText(/DEBUG|INFO|WARN|ERROR|FATAL/);
    await expect(page.locator(".log-msg").first()).not.toBeEmpty();
    // 刷新按钮可重复拉取
    await page.locator(".log-refresh").click();
    await expect(page.locator(".log-item").first()).toBeVisible();
  });
});

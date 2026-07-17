import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export async function createAgent(page: Page, id: string, name: string) {
  await page.goto("/agents/new");
  // 等待 SSR 水合完成，否则填充的值会被水合重渲染清空
  await page.waitForLoadState("networkidle");
  await page.getByLabel("ID").fill(id);
  await page.getByLabel("名称").fill(name);
  await expect(page.getByLabel("ID")).toHaveValue(id);
  await page.locator(".save-btn").click();

  // 创建成功后页面会跳转到 /agents/{id}
  await page.waitForURL(`/agents/${id}`);
}

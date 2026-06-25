import type { Page } from "@playwright/test";

export async function createAgent(page: Page, id: string, name: string) {
  await page.goto("/hub");
  await page.click("text=新建 Agent");

  const form = page.locator("form.agent-form");
  const inputs = form.locator("input");
  await inputs.nth(0).fill(id);
  await inputs.nth(1).fill(name);

  // Use the built-in Mock Provider so no real API key is required.
  const providerSelect = form.locator("select").first();
  await providerSelect.selectOption({ label: "Mock Provider" });

  await form.locator('button[type="submit"]').click();

  // Wait for the agent to appear in the sidebar, confirming creation succeeded.
  await page.locator(".sidebar li", { hasText: name }).waitFor();
}

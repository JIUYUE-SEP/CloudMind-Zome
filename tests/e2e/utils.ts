import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const ENGINE = "http://127.0.0.1:8848";
export const ENGINE_TOKEN = "e2e-test-token";

export async function createAgent(page: Page, id: string, name: string) {
  await page.goto("/agents/new");
  // 等待 SSR 水合完成，否则填充的值会被水合重渲染清空
  await page.waitForLoadState("networkidle");
  await page.getByLabel("ID").fill(id);
  await page.getByLabel("名称").fill(name);
  await expect(page.getByLabel("ID")).toHaveValue(id);
  await page.locator(".save-btn").click();

  // 创建成功后页面会跳转到 /agents/{id}/edit
  await page.waitForURL(`/agents/${id}/edit`);
}

/**
 * REST 直建 agent（注入依赖的用例用）：UI 创建默认 tools:[]（白名单空 = 无内置
 * 工具，注入的 tool call 会变 Unknown tool），需要工具的用例必须显式给白名单。
 */
export async function createAgentViaRest(
  request: { post: (url: string, opts?: unknown) => Promise<{ ok: () => boolean; status: () => number; text: () => Promise<string> }> },
  agent: { id: string; name: string; tools?: string[] },
) {
  const res = await request.post(`${ENGINE}/agents`, {
    headers: { authorization: `Bearer ${ENGINE_TOKEN}`, "content-type": "application/json" },
    data: { id: agent.id, name: agent.name, persona: "", skills: [], tools: agent.tools ?? [] },
  } as never);
  if (!res.ok()) {
    throw new Error(`createAgentViaRest 失败（${res.status()}）：${await res.text()}`);
  }
}

/** 经 e2e 注入端点给指定 agent 的 Mock provider 注入下一次 chat 的 tool calls */
export async function injectToolCalls(
  request: { post: (url: string, opts?: unknown) => Promise<{ ok: () => boolean }> },
  agentId: string,
  toolCalls: Array<{ toolCallId: string; name: string; arguments: unknown }>,
) {
  const res = await request.post(`${ENGINE}/e2e/mock/tool-calls`, {
    headers: { authorization: `Bearer ${ENGINE_TOKEN}` },
    data: { agentId, toolCalls },
  } as never);
  expect(res.ok()).toBe(true);
}

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import AgentEditTools from "../../../components/agent-edit/AgentEditTools.vue";

describe("AgentEditTools", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const path = typeof url === "string" ? url : url.toString();
      if (path.includes("/config/tools")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { name: "bash", toolset: "builtin", safeToParallel: false },
              { name: "memory", toolset: "builtin", safeToParallel: true },
            ]),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits update when a tool is toggled on", async () => {
    const wrapper = mount(AgentEditTools, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    await flushPromises();
    const checkbox = wrapper.findAll("input[type='checkbox']")[0];
    await checkbox.setValue(true);
    const last = wrapper.emitted("update")!.at(-1)![0] as { tools: string[] };
    expect(last.tools).toContain("bash");
  });
});

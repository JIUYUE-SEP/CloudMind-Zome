import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import AgentEditModel from "../../../components/agent-edit/AgentEditModel.vue";

describe("AgentEditModel", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      } as unknown as Response),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits update with finite temperature", async () => {
    const wrapper = mount(AgentEditModel, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const tempInput = wrapper.find("[placeholder='默认']");
    await tempInput.setValue("0.7");
    await tempInput.trigger("input");
    const last = wrapper.emitted("update")!.at(-1)![0] as { temperature: number };
    expect(last.temperature).toBe(0.7);
  });

  it("does not emit NaN for invalid temperature", async () => {
    const wrapper = mount(AgentEditModel, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const tempInput = wrapper.find("[placeholder='默认']");
    await tempInput.setValue("not-a-number");
    await tempInput.trigger("input");
    const last = wrapper.emitted("update")!.at(-1)![0] as { temperature: number | undefined };
    expect(last.temperature).toBeUndefined();
  });

  it("主模型下拉回显 agent.json 的 providerId + model（遗留字段映射）", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              id: "p1",
              displayName: "OpenAI",
              providerType: "openai",
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-4o", displayName: "GPT-4o", modelType: "llm" }],
            },
          ]),
      } as unknown as Response),
    );
    const wrapper = mount(AgentEditModel, {
      props: {
        agent: {
          id: "a1",
          name: "A1",
          persona: "",
          skills: [],
          tools: [],
          providerId: "p1",
          model: "gpt-4o-legacy",
        },
      },
    });
    await flushPromises();
    const select = wrapper.find("select");
    expect(select.element.value).toBe("p1:gpt-4o-legacy");
  });
});

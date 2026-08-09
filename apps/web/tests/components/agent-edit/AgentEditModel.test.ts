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

  it("续跑棒数上限：handoffMaxShifts 数字框 emit、越界 clamp、清空为 undefined（R6）", async () => {
    const wrapper = mount(AgentEditModel, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const input = wrapper.find("input[placeholder='默认（5）']");
    expect(wrapper.text()).toContain("续跑棒数上限");
    expect(wrapper.text()).toContain("自动续跑的最大棒数");

    await input.setValue("5");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ handoffMaxShifts: 5 });

    await input.setValue("12");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ handoffMaxShifts: 10 });

    await input.setValue("0");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ handoffMaxShifts: 1 });

    await input.setValue("");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ handoffMaxShifts: undefined });
  });

  it("ReAct 最大步数：reactMaxSteps 数字框 emit 并 clamp（R6）", async () => {
    const wrapper = mount(AgentEditModel, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const input = wrapper.find("input[placeholder='默认（100）']");
    await input.setValue("120");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ reactMaxSteps: 120 });

    await input.setValue("501");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ reactMaxSteps: 500 });
  });

  it("上下文窗口：maxContextTokens 数字框 emit（R6）", async () => {
    const wrapper = mount(AgentEditModel, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const input = wrapper.find("input[placeholder='默认（80000）']");
    await input.setValue("64000");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ maxContextTokens: 64000 });

    await input.setValue("");
    await input.trigger("change");
    expect(wrapper.emitted("update")!.at(-1)![0]).toEqual({ maxContextTokens: undefined });
  });
});

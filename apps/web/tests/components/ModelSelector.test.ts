import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import ModelSelector from "../../components/ModelSelector.vue";
import { useComputeStore } from "../../stores/compute";

describe("ModelSelector", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders model options", async () => {
    await useComputeStore().load();
    const wrapper = mount(ModelSelector, {
      props: { modelType: "llm", modelId: "" },
    });
    await flushPromises();
    const options = wrapper.findAll("option");
    // 占位项 + p1:gpt-4o
    expect(options.length).toBe(2);
    expect(options[1].attributes("value")).toBe("p1:gpt-4o");
  });

  it("emits update events on selection", async () => {
    await useComputeStore().load();
    const wrapper = mount(ModelSelector, {
      props: { modelType: "llm", modelId: "" },
    });
    await flushPromises();
    const select = wrapper.find("select");
    await select.setValue("p1:gpt-4o");
    expect(wrapper.emitted("update:providerId")?.[0]).toEqual(["p1"]);
    expect(wrapper.emitted("update:modelId")?.[0]).toEqual(["gpt-4o"]);
  });

  it("emits empty providerId and modelId when cleared", async () => {
    await useComputeStore().load();
    const wrapper = mount(ModelSelector, {
      props: { modelType: "llm", providerId: "p1", modelId: "gpt-4o" },
    });
    await flushPromises();
    const select = wrapper.find("select");
    await select.setValue("");
    expect(wrapper.emitted("update:providerId")?.[0]).toEqual([""]);
    expect(wrapper.emitted("update:modelId")?.[0]).toEqual([""]);
  });
});

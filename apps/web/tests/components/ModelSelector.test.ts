import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import ModelSelector from "../../components/ModelSelector.vue";

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
    const wrapper = mount(ModelSelector, {
      props: { modelType: "llm", modelId: "" },
    });
    await flushPromises();
    const options = wrapper.findAll("option");
    expect(options.length).toBeGreaterThan(0);
  });

  it("emits update events on selection", async () => {
    const wrapper = mount(ModelSelector, {
      props: { modelType: "llm", modelId: "" },
    });
    await flushPromises();
    const select = wrapper.find("select");
    await select.setValue("gpt-4o");
    expect(wrapper.emitted("update:modelId")).toBeTruthy();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import AgentEditForm from "../../components/AgentEditForm.vue";

describe("AgentEditForm", () => {
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

  it("emits save with form data", async () => {
    const wrapper = mount(AgentEditForm);
    await flushPromises();
    const inputs = wrapper.findAll("input");
    await inputs[0].setValue("a1");
    await inputs[1].setValue("Agent One");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("save")).toBeTruthy();
    const saved = wrapper.emitted("save")![0][0] as { id: string; name: string };
    expect(saved.id).toBe("a1");
    expect(saved.name).toBe("Agent One");
  });
});

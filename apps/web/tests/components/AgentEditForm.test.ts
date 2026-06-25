import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import AgentEditForm from "../../components/AgentEditForm.vue";

describe("AgentEditForm", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("emits save with form data", async () => {
    const wrapper = mount(AgentEditForm);
    const inputs = wrapper.findAll("input");
    await inputs[0].setValue("a1");
    await inputs[1].setValue("Agent One");
    await inputs[2].setValue("mock");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("save")).toBeTruthy();
  });
});

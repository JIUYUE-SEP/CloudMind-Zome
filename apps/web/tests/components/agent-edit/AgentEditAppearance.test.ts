import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import AgentEditAppearance from "../../../components/agent-edit/AgentEditAppearance.vue";

describe("AgentEditAppearance", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("renders avatar initial from agent name", () => {
    const wrapper = mount(AgentEditAppearance, {
      props: { agent: { id: "a1", name: "Alpha", persona: "", skills: [], tools: [] } },
    });
    expect(wrapper.find(".appearance-avatar").text()).toBe("A");
  });

  it("emits update when represent color changes", async () => {
    const wrapper = mount(AgentEditAppearance, {
      props: { agent: { id: "a1", name: "A", persona: "", skills: [], tools: [] } },
    });
    const colorInput = wrapper.find("input[type='color']");
    await colorInput.setValue("#ff0000");
    await colorInput.trigger("input");
    expect(wrapper.emitted("update")).toBeTruthy();
    const last = wrapper.emitted("update")!.at(-1)![0] as { representColor: string };
    expect(last.representColor).toBe("#ff0000");
  });

});

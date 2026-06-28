import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AgentEditPersona from "../../../components/agent-edit/AgentEditPersona.vue";

describe("AgentEditPersona", () => {
  it("emits update when persona changes", async () => {
    const wrapper = mount(AgentEditPersona, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const textarea = wrapper.find("textarea");
    await textarea.setValue("friendly assistant");
    await textarea.trigger("input");
    expect(wrapper.emitted("update")).toBeTruthy();
    const last = wrapper.emitted("update")!.at(-1)![0] as { persona: string };
    expect(last.persona).toBe("friendly assistant");
  });
});

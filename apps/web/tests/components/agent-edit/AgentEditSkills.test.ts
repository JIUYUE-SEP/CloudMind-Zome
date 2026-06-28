import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AgentEditSkills from "../../../components/agent-edit/AgentEditSkills.vue";

describe("AgentEditSkills", () => {
  it("emits update when a skill is added", async () => {
    const wrapper = mount(AgentEditSkills, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const input = wrapper.find("input");
    await input.setValue("search");
    await input.trigger("keydown.enter");
    const last = wrapper.emitted("update")!.at(-1)![0] as { skills: string[] };
    expect(last.skills).toContain("search");
  });

  it("emits update when a skill is removed", async () => {
    const wrapper = mount(AgentEditSkills, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: ["search"], tools: [] } },
    });
    await wrapper.find(".tag-remove").trigger("click");
    const last = wrapper.emitted("update")!.at(-1)![0] as { skills: string[] };
    expect(last.skills).not.toContain("search");
  });
});

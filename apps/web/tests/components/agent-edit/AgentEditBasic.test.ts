import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import AgentEditBasic from "../../../components/agent-edit/AgentEditBasic.vue";

describe("AgentEditBasic", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("emits update when name changes", async () => {
    const wrapper = mount(AgentEditBasic, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const inputs = wrapper.findAll("input");
    const nameInput = inputs.find((input) => input.element.value === "A1");
    expect(nameInput).toBeTruthy();
    await nameInput!.setValue("New Name");
    await nameInput!.trigger("input");
    expect(wrapper.emitted("update")).toBeTruthy();
    const last = wrapper.emitted("update")!.at(-1)![0] as { name: string };
    expect(last.name).toBe("New Name");
  });

  it("allows editing id in new mode", async () => {
    const wrapper = mount(AgentEditBasic, {
      props: { agent: { id: "", name: "", persona: "", skills: [], tools: [] }, isNew: true },
    });
    const idInput = wrapper.find("input:not([type='color'])");
    expect(idInput.attributes("disabled")).toBeUndefined();
    await idInput.setValue("new-id");
    await idInput.trigger("input");
    const last = wrapper.emitted("update")!.at(-1)![0] as { id: string };
    expect(last.id).toBe("new-id");
  });

  it("输入阶段不 trim，名称中的空格与结尾空格原样保留", async () => {
    const wrapper = mount(AgentEditBasic, {
      props: { agent: { id: "a1", name: "", persona: "", skills: [], tools: [] } },
    });
    const nameInput = wrapper.findAll("input")[1];
    await nameInput.setValue("My Agent ");
    await nameInput.trigger("input");
    const last = wrapper.emitted("update")!.at(-1)![0] as { name: string };
    expect(last.name).toBe("My Agent ");
  });

  it("emits update when a tag is added", async () => {
    const wrapper = mount(AgentEditBasic, {
      props: { agent: { id: "a1", name: "A1", persona: "", skills: [], tools: [] } },
    });
    const tagInput = wrapper.find("[placeholder='按 Enter 添加标签']");
    await tagInput.setValue("helper");
    await tagInput.trigger("keydown.enter");
    const last = wrapper.emitted("update")!.at(-1)![0] as { tags: string[] };
    expect(last.tags).toContain("helper");
  });
});

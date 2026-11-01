import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MessageInput from "../../components/MessageInput.vue";

describe("MessageInput", () => {
  it("空闲态：显示发送按钮，空文本时禁用", async () => {
    const wrapper = mount(MessageInput);
    const button = wrapper.find("button");
    expect(button.text()).toBe("发送");
    expect(button.attributes("disabled")).toBeDefined();

    await wrapper.find("input").setValue("hello");
    expect(wrapper.find("button").attributes("disabled")).toBeUndefined();
  });

  it("空闲态点击发送：emit send 并清空输入框", async () => {
    const wrapper = mount(MessageInput);
    await wrapper.find("input").setValue("  hello  ");
    await wrapper.find("button").trigger("click");

    expect(wrapper.emitted("send")).toEqual([["hello"]]);
    expect((wrapper.find("input").element as HTMLInputElement).value).toBe("");
  });

  it("流式态：按钮换成「停止」且可点击——disabled 会让人点不动", async () => {
    const wrapper = mount(MessageInput, { props: { isLoading: true } });
    const button = wrapper.find("button");

    expect(button.text()).toBe("停止");
    // 关键：即使输入框为空也必须能点。禁用的停止按钮等于没有停止
    expect(button.attributes("disabled")).toBeUndefined();
  });

  it("流式态点击停止：emit stop，不发消息", async () => {
    const wrapper = mount(MessageInput, { props: { isLoading: true } });
    // 输入框里已有内容也不能被当成发送
    await wrapper.find("input").setValue("写了一半的想法");
    await wrapper.find("button").trigger("click");

    expect(wrapper.emitted("stop")).toHaveLength(1);
    expect(wrapper.emitted("send")).toBeUndefined();
    // 停止不该吞掉用户已敲的内容
    expect((wrapper.find("input").element as HTMLInputElement).value).toBe("写了一半的想法");
  });

  it("流式态按回车不发送：避免生成中误触发第二轮", async () => {
    const wrapper = mount(MessageInput, { props: { isLoading: true } });
    const input = wrapper.find("input");
    await input.setValue("排队的话");
    await input.trigger("keydown.enter");

    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("输入法合成态的回车不发送：选词确认不能把拼音发出去", async () => {
    const wrapper = mount(MessageInput);
    const input = wrapper.find("input");
    await input.setValue("nihao");
    await input.trigger("keydown.enter", { isComposing: true });

    expect(wrapper.emitted("send")).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useUiModeStore } from "../../stores/ui-mode";

describe("ui-mode store（决策 1/3：localStorage 持久化 + 失效回退）", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("缺省 multi（localStorage 空=现状恒等），singleAgentId 空", () => {
    const store = useUiModeStore();
    expect(store.agentMode).toBe("multi");
    expect(store.singleAgentId).toBe("");
    expect(store.notice).toBe("");
  });

  it("setMode/selectAgent 持久化：写 localStorage，重建 store 后状态仍 single", () => {
    const store = useUiModeStore();
    store.setMode("single");
    expect(localStorage.getItem("cloudmind.agentMode")).toBe("single");
    store.selectAgent("a1");
    expect(localStorage.getItem("cloudmind.singleAgentId")).toBe("a1");

    // 新 pinia（模拟刷新）：从 localStorage 恢复
    setActivePinia(createPinia());
    const restored = useUiModeStore();
    expect(restored.agentMode).toBe("single");
    expect(restored.singleAgentId).toBe("a1");
  });

  it("非法 localStorage 值：回落缺省 multi", () => {
    localStorage.setItem("cloudmind.agentMode", "garbage");
    setActivePinia(createPinia());
    expect(useUiModeStore().agentMode).toBe("multi");
  });

  it("reconcile：单模式选中 agent 被删 → 回退 multi + 页面内提示", () => {
    const store = useUiModeStore();
    store.selectAgent("a1");
    store.reconcile([{ id: "a2" }]); // a1 已不在名录
    expect(store.agentMode).toBe("multi");
    expect(store.singleAgentId).toBe("");
    expect(store.notice).toContain("已被删除");
    expect(localStorage.getItem("cloudmind.agentMode")).toBe("multi");
  });

  it("reconcile 不误伤：agent 在名录 / 未选 agent / multi 模式全空转", () => {
    const store = useUiModeStore();
    store.selectAgent("a1");
    store.reconcile([{ id: "a1" }]);
    expect(store.agentMode).toBe("single");

    // 单模式但未选 agent（清 localStorage + 全新 pinia 拿干净实例）
    localStorage.clear();
    setActivePinia(createPinia());
    const unselected = useUiModeStore();
    unselected.setMode("single");
    unselected.reconcile([]);
    expect(unselected.agentMode).toBe("single"); // 保持单模式等用户选择

    unselected.setMode("multi");
    unselected.reconcile([]);
    expect(unselected.agentMode).toBe("multi");
    expect(unselected.notice).toBe("");
  });
});

import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentConfig } from "@cloudmind/shared";
import { useEngineClient } from "@/composables/useEngineClient";
import { createListLoader } from "@/utils/list-loader";

export const useAgentsStore = defineStore("agents", () => {
  const client = useEngineClient();
  // 加载态/错误态/代际防脏写走共享模板（D2 收敛）
  const { list, isLoading, error, load: loadList } = createListLoader<AgentConfig>();
  /**
   * 名录就绪门槛（review High 修复）：仅成功落定过一次 load 才为 true——
   * 加载完成前的空列表 ≠ 已删除（单/多模式 reconcile 据此才敢做回退判定；
   * 加载失败不置位，失败态的名录不可信，同样不得回退）
   */
  const loadedOnce = ref(false);

  async function load() {
    await loadList(() => client.listAgents());
    if (!error.value) loadedOnce.value = true;
  }

  async function create(agent: AgentConfig) {
    const created = await client.createAgent(agent);
    list.value.push(created);
    return created;
  }

  async function update(id: string, agent: AgentConfig) {
    const updated = await client.updateAgent(id, agent);
    const idx = list.value.findIndex((a) => a.id === id);
    if (idx >= 0) list.value[idx] = updated;
    return updated;
  }

  async function remove(id: string) {
    await client.deleteAgent(id);
    list.value = list.value.filter((a) => a.id !== id);
  }

  return { list, isLoading, error, loadedOnce, load, create, update, remove };
});

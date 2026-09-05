import { defineStore } from "pinia";
import type { AgentConfig } from "@cloudmind/shared";
import { useEngineClient } from "@/composables/useEngineClient";
import { createListLoader } from "@/utils/list-loader";

export const useAgentsStore = defineStore("agents", () => {
  const client = useEngineClient();
  // 加载态/错误态/代际防脏写走共享模板（D2 收敛）
  const { list, isLoading, error, load: loadList } = createListLoader<AgentConfig>();

  async function load() {
    await loadList(() => client.listAgents());
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

  return { list, isLoading, error, load, create, update, remove };
});

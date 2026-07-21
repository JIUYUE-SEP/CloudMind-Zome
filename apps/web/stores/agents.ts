import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentConfig } from "@mindcloud/shared";
import { useEngineClient } from "@/composables/useEngineClient";

export const useAgentsStore = defineStore("agents", () => {
  const client = useEngineClient();
  const list = ref<AgentConfig[]>([]);
  const isLoading = ref(false);
  const error = ref("");

  async function load() {
    isLoading.value = true;
    error.value = "";
    try {
      list.value = await client.listAgents();
    } catch (err) {
      error.value = err instanceof Error ? err.message : "加载失败";
    } finally {
      isLoading.value = false;
    }
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

import { defineStore } from "pinia";
import { useEngineClient } from "@/composables/useEngineClient";
import type { Blueprint, BlueprintExecution } from "@/composables/useEngineClient";
import { createListLoader } from "@/utils/list-loader";

export const useBlueprintsStore = defineStore("blueprints", () => {
  const client = useEngineClient();
  // 加载态/错误态/代际防脏写走共享模板（D2 收敛）
  const { list: blueprints, isLoading, error, load: loadList } = createListLoader<Blueprint>();

  async function load() {
    await loadList(() => client.listBlueprints());
  }

  async function create(blueprint: Omit<Blueprint, "id" | "createdAt" | "updatedAt">) {
    const created = await client.createBlueprint(blueprint);
    blueprints.value.push(created);
    return created;
  }

  async function update(id: string, patch: Partial<Blueprint>) {
    const updated = await client.updateBlueprint(id, patch);
    const idx = blueprints.value.findIndex((b) => b.id === id);
    if (idx >= 0) blueprints.value[idx] = updated;
    return updated;
  }

  async function remove(id: string) {
    await client.deleteBlueprint(id);
    blueprints.value = blueprints.value.filter((b) => b.id !== id);
  }

  async function execute(id: string, initialInput?: string): Promise<BlueprintExecution> {
    return client.executeBlueprint(id, initialInput);
  }

  return { blueprints, isLoading, error, load, create, update, remove, execute };
});

import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";

export interface ScheduledTask {
  id: string;
  agentId: string;
  description: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

export const useSchedulerStore = defineStore("scheduler", () => {
  const client = useEngineClient();
  const tasks = ref<ScheduledTask[]>([]);

  async function load(agentId: string) {
    tasks.value = await client.getScheduledTasks(agentId);
  }

  async function create(agentId: string, task: Omit<ScheduledTask, "id" | "agentId">) {
    const created = await client.createScheduledTask(agentId, task);
    await load(agentId);
    return created;
  }

  async function update(agentId: string, taskId: string, patch: Partial<ScheduledTask>) {
    await client.updateScheduledTask(agentId, taskId, patch);
    await load(agentId);
  }

  async function remove(agentId: string, taskId: string) {
    await client.deleteScheduledTask(agentId, taskId);
    await load(agentId);
  }

  return { tasks, load, create, update, remove };
});

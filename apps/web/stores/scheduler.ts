import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { ScheduledTask } from "@mindcloud/shared";

export type { ScheduledTask };

export const useSchedulerStore = defineStore("scheduler", () => {
  const client = useEngineClient();
  const tasks = ref<ScheduledTask[]>([]);
  const error = ref("");
  // 防止切换 Agent 后旧的 load 结果覆盖新选择
  let loadSeq = 0;
  let tasksAgentId = "";

  async function load(agentId: string) {
    const seq = ++loadSeq;
    error.value = "";
    // 切换 Agent 时先清空，避免加载在途期间旧 Agent 的任务被误读为当前 Agent 的
    if (tasksAgentId !== agentId) {
      tasks.value = [];
      tasksAgentId = agentId;
    }
    try {
      const result = await client.getScheduledTasks(agentId);
      if (seq === loadSeq) tasks.value = result;
    } catch (err) {
      if (seq === loadSeq) error.value = err instanceof Error ? err.message : "加载失败";
    }
  }

  // engine 创建时忽略 id/agentId/时间戳并自算 nextRunAt，类型上直接排除（与 client.createScheduledTask 对齐）
  async function create(
    agentId: string,
    task: Omit<ScheduledTask, "id" | "agentId" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">
  ) {
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

  return { tasks, error, load, create, update, remove };
});

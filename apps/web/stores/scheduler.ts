import { defineStore } from "pinia";
import { useEngineClient } from "@/composables/useEngineClient";
import { createListLoader } from "@/utils/list-loader";
import type { ScheduledTask } from "@cloudmind/shared";

export type { ScheduledTask };

export const useSchedulerStore = defineStore("scheduler", () => {
  const client = useEngineClient();
  // 错误态/代际防脏写走共享模板（D2 收敛；本 store 不暴露 isLoading）
  const { list: tasks, error, load: loadList } = createListLoader<ScheduledTask>();
  let tasksAgentId = "";

  async function load(agentId: string) {
    // 切换 Agent 时先清空，避免加载在途期间旧 Agent 的任务被误读为当前 Agent 的
    if (tasksAgentId !== agentId) {
      tasks.value = [];
      tasksAgentId = agentId;
    }
    // 模板代际防脏写：切换 Agent 后旧的 load 结果不会覆盖新选择
    await loadList(() => client.getScheduledTasks(agentId));
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

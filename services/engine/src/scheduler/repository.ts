import { randomUUID } from "node:crypto";
import path from "node:path";
// document-store 已迁入 memory 插件目录作内部实现（P4）；本边为批准的保留边——
// 库级直 import（非 ctx 服务），scheduler P7 插件化时再评估收口
import { DocumentStore } from "../plugins/memory/document-store.js";
import { getAgentDir, sanitizeAgentId } from "../config/paths.js";
import type { ScheduledTask } from "./types.js";

export class SchedulerRepository {
  private store: DocumentStore<ScheduledTask>;

  constructor(agentId: string) {
    sanitizeAgentId(agentId);
    this.store = new DocumentStore<ScheduledTask>(path.join(getAgentDir(agentId), "scheduler.jsonl"));
  }

  async list(): Promise<ScheduledTask[]> {
    return this.store.readLines();
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    const tasks = await this.list();
    return tasks.find((t) => t.id === id);
  }

  async create(task: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">): Promise<ScheduledTask> {
    const now = new Date().toISOString();
    const full: ScheduledTask = { ...task, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.store.appendLine(full);
    return full;
  }

  async update(task: ScheduledTask): Promise<void> {
    await this.store.mutateLines((tasks) => {
      const index = tasks.findIndex((t) => t.id === task.id);
      if (index === -1) throw new Error(`task not found: ${task.id}`);
      tasks[index] = { ...task, updatedAt: new Date().toISOString() };
      return tasks;
    });
  }

  async delete(id: string): Promise<void> {
    await this.store.mutateLines((tasks) => tasks.filter((t) => t.id !== id));
  }
}

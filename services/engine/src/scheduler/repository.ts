import { randomUUID } from "node:crypto";
import path from "node:path";
import { DocumentStore } from "../memory/document-store.js";
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
    const tasks = await this.list();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) throw new Error(`task not found: ${task.id}`);
    tasks[index] = { ...task, updatedAt: new Date().toISOString() };
    await this.store.writeLines(tasks);
  }

  async delete(id: string): Promise<void> {
    const tasks = await this.list();
    const filtered = tasks.filter((t) => t.id !== id);
    await this.store.writeLines(filtered);
  }
}

import { randomUUID } from "node:crypto";
import path from "node:path";
import { DocumentStore } from "../memory/document-store.js";
import { getDataDir } from "../config/paths.js";
import type { Blueprint } from "./types.js";

export class BlueprintRepository {
  private store: DocumentStore<Blueprint>;

  constructor() {
    this.store = new DocumentStore<Blueprint>(path.join(getDataDir(), "blueprints.jsonl"));
  }

  async list(): Promise<Blueprint[]> {
    return this.store.readLines();
  }

  async get(id: string): Promise<Blueprint | undefined> {
    const blueprints = await this.list();
    return blueprints.find((b) => b.id === id);
  }

  async create(blueprint: Omit<Blueprint, "id" | "createdAt" | "updatedAt">): Promise<Blueprint> {
    const now = new Date().toISOString();
    const full: Blueprint = { ...blueprint, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.store.appendLine(full);
    return full;
  }

  async update(blueprint: Blueprint): Promise<void> {
    const blueprints = await this.list();
    const index = blueprints.findIndex((b) => b.id === blueprint.id);
    if (index === -1) throw new Error(`blueprint not found: ${blueprint.id}`);
    blueprints[index] = { ...blueprint, updatedAt: new Date().toISOString() };
    await this.store.writeLines(blueprints);
  }

  async delete(id: string): Promise<void> {
    const blueprints = await this.list();
    const filtered = blueprints.filter((b) => b.id !== id);
    await this.store.writeLines(filtered);
  }
}

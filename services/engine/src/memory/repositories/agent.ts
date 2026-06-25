import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "@mindcloud/shared";
import { DocumentStore } from "../document-store.js";
import { getAgentDir, getDataDir, sanitizeAgentId } from "../../config/paths.js";
import type { IAgentRepository } from "./types.js";

const MAX_CACHE_SIZE = 64;

export class AgentRepository implements IAgentRepository {
  private cache = new Map<string, { config: AgentConfig; watcher: fs.FSWatcher }>();

  private store(agentId: string): DocumentStore<AgentConfig> {
    return new DocumentStore<AgentConfig>(path.join(getAgentDir(sanitizeAgentId(agentId)), "agent.json"));
  }

  private async loadAndWatch(agentId: string): Promise<AgentConfig | undefined> {
    const store = this.store(agentId);
    const config = await store.readJson();
    if (!config) return undefined;

    // Simple LRU eviction
    if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(agentId)) {
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey) {
        const entry = this.cache.get(firstKey);
        entry?.watcher.close();
        this.cache.delete(firstKey);
      }
    }

    const watcher = fs.watch(store.filePath, () => {
      const entry = this.cache.get(agentId);
      if (entry) {
        entry.watcher.close();
        this.cache.delete(agentId);
      }
    });

    this.cache.set(agentId, { config, watcher });
    return config;
  }

  async get(agentId: string): Promise<AgentConfig | undefined> {
    sanitizeAgentId(agentId);
    const cached = this.cache.get(agentId);
    if (cached) {
      // Move to the end to keep LRU order.
      this.cache.delete(agentId);
      this.cache.set(agentId, cached);
      return cached.config;
    }
    return this.loadAndWatch(agentId);
  }

  async save(agentId: string, config: AgentConfig): Promise<void> {
    const id = sanitizeAgentId(agentId);
    const existing = this.cache.get(id);
    if (existing) {
      existing.watcher.close();
      this.cache.delete(id);
    }
    const store = this.store(id);
    await store.writeJson(config);
    await this.loadAndWatch(id);
  }

  async delete(agentId: string): Promise<void> {
    const id = sanitizeAgentId(agentId);
    const existing = this.cache.get(id);
    if (existing) {
      existing.watcher.close();
      this.cache.delete(id);
    }
    const dir = getAgentDir(id);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  async list(): Promise<AgentConfig[]> {
    const dataDir = getDataDir();
    try {
      const agentsDir = path.join(dataDir, "agents");
      const entries = await fs.promises.readdir(agentsDir, { withFileTypes: true });
      const configs: AgentConfig[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = path.join(agentsDir, entry.name, "agent.json");
        const content = await fs.promises.readFile(filePath, "utf-8").catch(() => undefined);
        if (!content) continue;
        const config = JSON.parse(content) as AgentConfig;
        configs.push(config);
      }
      return configs;
    } catch {
      return [];
    }
  }

  dispose(): void {
    for (const entry of this.cache.values()) {
      entry.watcher.close();
    }
    this.cache.clear();
  }
}

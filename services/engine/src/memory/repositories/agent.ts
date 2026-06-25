import fs from "node:fs";
import fsp from "node:fs/promises";
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

  private invalidate(agentId: string): void {
    const entry = this.cache.get(agentId);
    if (entry) {
      entry.watcher.close();
      this.cache.delete(agentId);
    }
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

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(store.filePath, (eventType) => {
        if (eventType === "rename") {
          // file may have been deleted; always invalidate
          this.invalidate(agentId);
        }
        // for "change", invalidate only if content actually changed
        this.invalidate(agentId);
      });
    } catch (err) {
      console.error(`Failed to watch agent config ${store.filePath}:`, err);
      // cache without watcher
      this.cache.set(agentId, { config, watcher: { close: () => {} } as unknown as fs.FSWatcher });
      return config;
    }

    watcher.on("error", (err) => {
      console.error(`Watcher error for ${store.filePath}:`, err);
      this.invalidate(agentId);
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
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async list(): Promise<AgentConfig[]> {
    const dataDir = getDataDir();
    try {
      const agentsDir = path.join(dataDir, "agents");
      const entries = await fsp.readdir(agentsDir, { withFileTypes: true });
      const configs: AgentConfig[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = path.join(agentsDir, entry.name, "agent.json");
        try {
          const content = await fsp.readFile(filePath, "utf-8");
          const config = JSON.parse(content) as AgentConfig;
          configs.push(config);
        } catch (err) {
          console.error(`Failed to load agent config from ${filePath}:`, err);
        }
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

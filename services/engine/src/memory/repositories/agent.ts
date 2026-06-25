import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "@mindcloud/shared";
import { DocumentStore } from "../document-store.js";
import { getAgentDir, getDataDir, sanitizeAgentId } from "../../config/paths.js";
import type { IAgentRepository } from "./types.js";

interface CacheEntry {
  config: AgentConfig;
  watcher?: fs.FSWatcher;
}

export class AgentRepository implements IAgentRepository {
  private cache = new Map<string, CacheEntry>();

  private store(agentId: string): DocumentStore<AgentConfig> {
    return new DocumentStore<AgentConfig>(path.join(getAgentDir(sanitizeAgentId(agentId)), "agent.json"));
  }

  private invalidate(agentId: string): void {
    const entry = this.cache.get(agentId);
    if (entry?.watcher) {
      entry.watcher.close();
    }
    this.cache.delete(agentId);
  }

  private setupWatcher(agentId: string, filePath: string): void {
    try {
      const watcher = fs.watch(filePath, () => {
        this.invalidate(agentId);
      });
      const entry = this.cache.get(agentId);
      if (entry) {
        entry.watcher = watcher;
      } else {
        watcher.close();
      }
    } catch {
      // Ignore watch setup failures; cache will fall back to file reads.
    }
  }

  async get(agentId: string): Promise<AgentConfig | undefined> {
    const id = sanitizeAgentId(agentId);
    const cached = this.cache.get(id);
    if (cached) {
      return cached.config;
    }

    const store = this.store(id);
    const config = await store.readJson();
    if (config) {
      this.cache.set(id, { config });
      this.setupWatcher(id, path.join(getAgentDir(id), "agent.json"));
    }
    return config;
  }

  async save(agentId: string, config: AgentConfig): Promise<void> {
    const id = sanitizeAgentId(agentId);
    this.invalidate(id);
    const store = this.store(id);
    await store.writeJson(config);
    this.cache.set(id, { config });
    this.setupWatcher(id, path.join(getAgentDir(id), "agent.json"));
  }

  async delete(agentId: string): Promise<void> {
    const id = sanitizeAgentId(agentId);
    this.invalidate(id);
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
        const config = await this.get(entry.name).catch(() => undefined);
        if (config) configs.push(config);
      }
      return configs;
    } catch {
      return [];
    }
  }
}

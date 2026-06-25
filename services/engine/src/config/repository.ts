import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./paths.js";

export interface ModelInfo {
  id: string;
  displayName: string;
  modelType: "llm" | "embedding" | "image" | "stt";
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
  supportsToolCalling?: boolean;
  supportsMultimodal?: boolean;
}

export interface ProviderConfig {
  id: string;
  displayName: string;
  providerType: "openai";
  baseUrl: string;
  apiKey?: string;
  models: ModelInfo[];
  requestTimeout?: number;
  maxRetries?: number;
}

export interface MemorySettings {
  compactThreshold: number;
  keepRecent: number;
  hotMemoryLimit: number;
  warmMemoryLimit: number;
}

export interface AppSettings {
  tavilyApiKey?: string;
  memory: MemorySettings;
}

export interface GlobalConfig {
  providers: ProviderConfig[];
  settings: AppSettings;
}

const DEFAULT_CONFIG: GlobalConfig = {
  providers: [],
  settings: {
    memory: {
      compactThreshold: 0.8,
      keepRecent: 3,
      hotMemoryLimit: 10,
      warmMemoryLimit: 20,
    },
  },
};

export class ConfigRepository {
  private filePath: string;

  constructor() {
    this.filePath = path.join(getDataDir(), "config.json");
  }

  async load(): Promise<GlobalConfig> {
    try {
      const text = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(text) as Partial<GlobalConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  async save(config: GlobalConfig): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(config, null, 2), "utf-8");
  }
}

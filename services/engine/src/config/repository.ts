import { logger } from "../logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../memory/document-store.js";
import {
  CURRENT_SCHEMA_VERSION,
  MigrationChain,
  splitSchemaVersion,
  stampSchemaVersion,
} from "../versioning.js";
import { decrypt, encrypt } from "./crypto.js";
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

// DEFAULT_CONFIG 是共享对象，必须返回深拷贝，避免调用方 push/mutate 污染全局默认值
function createDefaultConfig(): GlobalConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** config.json 顶层格式迁移链（P1-1）：当前 v1 无实际迁移，机制就位 */
const CONFIG_CHAIN = new MigrationChain<Partial<GlobalConfig>>(CURRENT_SCHEMA_VERSION);

async function decryptValue(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.startsWith("enc:")) return value;
  try {
    return await decrypt(value.slice(4));
  } catch (err) {
    // master key 变更/丢失时解密必然失败：字段按未配置处理，但必须留痕，
    // 否则用户看到的只是"apiKey 凭空消失"
    logger.warn({ err: err }, "[config] 解密失败，该字段按未配置处理（master key 可能已变更）:");
    return undefined;
  }
}

export class ConfigRepository {
  private filePath: string;
  // 并发 save 串行化（P0 review 返工）：save 共享固定 tmp 名，不排队会互相覆盖
  private saveQueue: Promise<void> = Promise.resolve();
  // 最近一次 load 的 decrypt 失败数：>0 时阻断 save（P0 review 返工）
  private decryptFailures = 0;

  constructor() {
    this.filePath = path.join(getDataDir(), "config.json");
  }

  async load(): Promise<GlobalConfig> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf-8");
    } catch (err) {
      // 只有"文件不存在"才回默认配置；其余读取错误必须显式抛出
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return createDefaultConfig();
      }
      throw err;
    }

    let parsed: Partial<GlobalConfig>;
    try {
      parsed = JSON.parse(text) as Partial<GlobalConfig>;
    } catch (err) {
      // 文件存在但已损坏：隔离原文件再抛错。绝不静默回默认——
      // 否则后续 save 会把损坏文件（含全部加密 apiKey）覆盖成空配置，数据永久丢失
      const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
      await renameWithRetry(this.filePath, quarantinePath).catch(() => {});
      throw new Error(
        `配置文件损坏，已隔离到 ${quarantinePath}，请人工恢复：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 版本字段（P1-1）：无 schemaVersion 的旧配置视为 v1；高于当前版本抛
    // UnsupportedSchemaVersionError（文件没坏，是代码太旧——不隔离、不回默认、不上
    // 面的损坏 catch 吞）；旧版经迁移链惰性迁移
    const { version, data } = splitSchemaVersion(parsed);
    parsed = CONFIG_CHAIN.migrate(data, version, this.filePath);

    const defaults = createDefaultConfig();
    const config: GlobalConfig = {
      ...defaults,
      ...parsed,
      settings: { ...defaults.settings, ...parsed.settings },
    };

    let decryptFailures = 0;
    for (const provider of config.providers) {
      if (provider.apiKey?.startsWith("enc:")) {
        const decrypted = await decryptValue(provider.apiKey);
        if (decrypted === undefined) decryptFailures++;
        provider.apiKey = decrypted;
      }
    }
    if (config.settings) {
      const key = config.settings.tavilyApiKey;
      if (key?.startsWith("enc:")) {
        const decrypted = await decryptValue(key);
        if (decrypted === undefined) decryptFailures++;
        config.settings.tavilyApiKey = decrypted;
      }
    }
    this.decryptFailures = decryptFailures;

    return config;
  }

  async save(config: GlobalConfig): Promise<void> {
    // 并发 save 串行化（P0 review 返工）：tmp 名固定，并发 save 交错会
    // "A 写 tmp → B 覆盖 → A rename 到 B 的内容 → B rename 撞 ENOENT"，
    // A 的修改静默丢失。排队后任一失败不影响后续调用
    const run = this.saveQueue.then(() => this.saveInner(config));
    this.saveQueue = run.catch(() => {});
    return run;
  }

  private async saveInner(config: GlobalConfig): Promise<void> {
    // decrypt 降级阻断（P0 review 返工）：master key 暂时不可用时 load 会把
    // apiKey 降级为 undefined，此时 save 会把它永久写成 undefined
    if (this.decryptFailures > 0) {
      throw new Error(
        `配置中有 ${this.decryptFailures} 个加密字段解密失败（master key 可能已变更或暂不可用），` +
          `已阻断保存以防 apiKey 被清空；请恢复 master key 或人工处理 config.json 后重试`,
      );
    }
    const toSave = stampSchemaVersion<GlobalConfig>(
      {
        ...config,
        providers: await Promise.all(
          config.providers.map(async (p) => ({
            ...p,
            apiKey: p.apiKey ? `enc:${await encrypt(p.apiKey)}` : undefined,
          })),
        ),
        settings: {
          ...config.settings,
          tavilyApiKey: config.settings.tavilyApiKey
            ? `enc:${await encrypt(config.settings.tavilyApiKey)}`
            : undefined,
        },
      },
      CONFIG_CHAIN.currentVersion,
    );
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 原子写：先写 tmp 再 rename，避免写一半崩溃留下半截 config.json
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(toSave, null, 2), "utf-8");
    await renameWithRetry(tmpPath, this.filePath);
  }
}

import { logger } from "../../logger.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "@mindcloud/shared";
import { DocumentStore } from "../../plugins/memory/document-store.js";
import { UnsupportedSchemaVersionError } from "../../versioning.js";
import { getAgentDir, getDataDir, sanitizeAgentId } from "../../config/paths.js";
import { ErrorThrottle } from "../../plugins/log/error-throttle.js";
import type { IAgentRepository } from "./types.js";

const MAX_CACHE_SIZE = 64;

export class AgentRepository implements IAgentRepository {
  private cache = new Map<string, { config: AgentConfig; watcher: fs.FSWatcher }>();
  onChange?: (agentId: string, config: AgentConfig | null) => void;
  /** P4 review Major-1：watcher 错误节流（文件持续损坏/反复写坏时不刷屏） */
  private readonly errors: ErrorThrottle;

  constructor(options: { errorThrottle?: ErrorThrottle } = {}) {
    this.errors = options.errorThrottle ?? new ErrorThrottle();
  }

  // 节流 key 用稳定的错误类别（watcher:{agentId}:{类别}），不用含动态内容的
  // 错误消息——消息带路径/堆栈会让 key 发散、节流失效（review Minor-1）
  private logWatchError(kind: "reload" | "watch" | "error", agentId: string, err: unknown, msg: string): void {
    const key = `watcher:${agentId}:${kind}`;
    const hit = this.errors.hit(key);
    if (!hit) return;
    logger.error({ err, agentId, throttleKey: key, count: hit.count, suppressed: hit.suppressed }, msg);
  }

  /** 对应操作再次成功即恢复：清除该类别条目并记一条"已恢复"（节流不吞信息） */
  private recoverWatch(kind: "reload" | "watch" | "error", agentId: string): void {
    const key = `watcher:${agentId}:${kind}`;
    const hit = this.errors.recover(key);
    if (!hit) return;
    logger.info(
      { agentId, throttleKey: key, count: hit.count, suppressed: hit.suppressed },
      `agent config watcher 已恢复（${kind}）`,
    );
  }

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
      watcher = fs.watch(store.filePath, async () => {
        try {
          const reloaded = await store.readJson();
          if (reloaded) {
            this.cache.set(agentId, { config: reloaded, watcher });
            this.onChange?.(agentId, reloaded);
            // 变更事件再次解析成功：此前的 reload 失败视为恢复
            this.recoverWatch("reload", agentId);
          } else {
            this.invalidate(agentId);
            this.onChange?.(agentId, null);
          }
        } catch (err) {
          this.logWatchError("reload", agentId, err, `Failed to reload agent config ${store.filePath}:`);
          this.invalidate(agentId);
          this.onChange?.(agentId, null);
        }
      });
    } catch (err) {
      this.logWatchError("watch", agentId, err, `Failed to watch agent config ${store.filePath}:`);
      // cache without watcher
      this.cache.set(agentId, { config, watcher: { close: () => {} } as unknown as fs.FSWatcher });
      return config;
    }

    watcher.on("error", (err) => {
      this.logWatchError("error", agentId, err, `Watcher error for ${store.filePath}:`);
      this.invalidate(agentId);
      this.onChange?.(agentId, null);
    });

    // watcher 重建成功：此前的 watch 创建失败 / watcher error 视为恢复。
    // reload 类别不在此恢复——它的恢复点是"变更事件再次解析成功"（上面的回调），
    // 否则"文件反复写坏 + get() 重建 watcher"的场景每轮先恢复再报错，节流被绕过
    this.recoverWatch("watch", agentId);
    this.recoverWatch("error", agentId);

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
    // 目录名即 id：强制写回，防止缺 id 的 agent.json 让 list/get 结果不可用
    await store.writeJson({ ...config, id });
    this.onChange?.(id, config);
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
    this.onChange?.(id, null);
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
          // 走 DocumentStore.readJson：版本检查/迁移与 get() 路径一致（P1-1）
          const config = await new DocumentStore<AgentConfig>(filePath).readJson();
          if (!config) continue; // readdir 之后被并发删除
          // 目录名即 id（get() 按目录名寻址）：外部写入的配置可能缺 id 或 id 不一致，
          // 统一以目录名为准，否则前端拿到 id 为 undefined 的条目，点击/编辑全部失效
          configs.push({ ...config, id: entry.name });
        } catch (err) {
          // 版本过高（数据由更新版本的程序写入）必须显式上抛——
          // 不能让 agent 静默从列表消失（那正是 M4 要防的"老数据静默读不出"）
          if (err instanceof UnsupportedSchemaVersionError) throw err;
          logger.error({ err: err }, `Failed to load agent config from ${filePath}:`);
        }
      }
      return configs;
    } catch (err) {
      // agents 目录不存在等整体失败返回空；但版本过高必须显式上抛（不静默读空）
      if (err instanceof UnsupportedSchemaVersionError) throw err;
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

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { logger } from "../logger.js";
import { DocumentStore, renameWithRetry } from "../plugins/memory/document-store.js";
import { getDataDir } from "../config/paths.js";
import { UnsupportedSchemaVersionError } from "../versioning.js";

/**
 * 工具 blurb 落盘条目（spec 决策 2）：只存 blurb + 描述哈希 + source + 时间，
 * **不存描述原文**。source: "llm"（v2 自动策展）| "user"（v3 用户编辑预留——
 * user 条目永不被自动重新生成覆盖，本层只管存取，覆盖规则在调用方）。
 */
export interface ToolBlurbEntry {
  blurb: string;
  descHash: string;
  source: "llm" | "user";
  updatedAt: string;
}

export type ToolBlurbFile = Record<string, ToolBlurbEntry>;

/** 描述原文哈希（复用命中键）：sha1 截 12 */
export function descHashOf(description: string): string {
  return createHash("sha1").update(description).digest("hex").slice(0, 12);
}

/**
 * tool-blurbs.json 存储层：DocumentStore 同款 tmp+rename 原子写；
 * 损坏 .corrupt 隔离 + 空态启动（照 topic-state 先例）——坏文件绝不静默覆盖，
 * 也绝不让它炸 worker 装配（blurb 是可再生缓存，空态重算即可）。
 * store 为全局单例（plugins 装配面提供），单写者语义下 upsert 读-改-写合并足够。
 */
export class ToolBlurbStore {
  private readonly store: DocumentStore<ToolBlurbFile>;

  constructor(filePath: string = path.join(getDataDir(), "tool-blurbs.json")) {
    this.store = new DocumentStore<ToolBlurbFile>(filePath);
  }

  get filePath(): string {
    return this.store.filePath;
  }

  /** 全量读取；文件不存在/损坏（已隔离）返回空表 */
  async getAll(): Promise<ToolBlurbFile> {
    try {
      return (await this.store.readJson()) ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      // 高版本文件不是损坏（versioning 契约：不做任何改动），原样上抛
      if (err instanceof UnsupportedSchemaVersionError) throw err;
      // 损坏隔离（照 topic-state.ts 同模式）：.corrupt-{ts}-{随机} 备份后空态启动
      const quarantinePath = `${this.store.filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
      let quarantined = false;
      try {
        await renameWithRetry(this.store.filePath, quarantinePath);
        quarantined = true;
      } catch (renameErr) {
        logger.warn(
          { err: renameErr, quarantinePath },
          "[tool-blurb] tool-blurbs.json 隔离失败（损坏文件仍在原路径）",
        );
      }
      logger.warn(
        { err: err, quarantinePath, quarantined },
        quarantined
          ? "[tool-blurb] tool-blurbs.json 损坏，已隔离并以空态启动（blurb 将重新生成）"
          : "[tool-blurb] tool-blurbs.json 损坏且隔离失败：以空态启动",
      );
      return {};
    }
  }

  async get(name: string): Promise<ToolBlurbEntry | undefined> {
    return (await this.getAll())[name];
  }

  /** 合并写入（读-改-写；全局单例单写者语义） */
  async upsert(entries: Array<[string, ToolBlurbEntry]>): Promise<void> {
    if (entries.length === 0) return;
    const current = await this.getAll();
    for (const [name, entry] of entries) current[name] = entry;
    await this.store.writeJson(current);
  }

  /** 单件写（v3 用户编辑用，读-改-写合并同款） */
  async upsertOne(name: string, entry: ToolBlurbEntry): Promise<void> {
    await this.upsert([[name, entry]]);
  }
}

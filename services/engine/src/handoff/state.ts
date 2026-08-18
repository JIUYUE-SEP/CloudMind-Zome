import path from "node:path";
import { randomUUID } from "node:crypto";
import { DocumentStore, renameWithRetry } from "../plugins/memory/document-store.js";
import { getDataDir } from "../config/paths.js";
import { logger } from "../logger.js";
import { UnsupportedSchemaVersionError } from "../versioning.js";
import { isActiveHandoff, type HandoffRecord, type HandoffStateFile } from "./types.js";

/**
 * handoff-state.json 控制面存储（换班移交的持久化事实）。
 * 复用 DocumentStore：单文件 JSON、schemaVersion 戳、tmp+rename 原子写。
 */
export class HandoffStateStore {
  private store: DocumentStore<HandoffStateFile>;

  constructor(filePath: string = path.join(getDataDir(), "handoff-state.json")) {
    this.store = new DocumentStore<HandoffStateFile>(filePath);
  }

  async loadAll(): Promise<HandoffRecord[]> {
    let file: HandoffStateFile | undefined;
    try {
      file = await this.store.readJson();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      // F2：高版本文件不是损坏——版本错误原样上抛（照 config/repository.ts 范式：
      // 版本检查不进损坏隔离分支），不隔离、不回空态，文件不做任何改动
      // （versioning.ts「高版本文件不做任何改动」契约）；仅真损坏才走下方隔离
      if (err instanceof UnsupportedSchemaVersionError) throw err;
      // A3 损坏隔离（照抄 config/repository.ts 的隔离路径语义）：重命名 .corrupt-
      // {timestamp}-{随机后缀} 备份后以空态启动 + warn——绝不静默覆盖损坏数据
      // （后续 save 会重建干净文件），也不会因坏文件让整个启动崩溃。
      // F5：随机后缀防同一毫秒内多次 loadAll 撞同名；rename 失败不再静默吞——
      // 单独 warn 带失败原因，且外层 warn 如实区分「已隔离」与「隔离失败」。
      const quarantinePath = `${this.store.filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
      let quarantined = false;
      try {
        await renameWithRetry(this.store.filePath, quarantinePath);
        quarantined = true;
      } catch (renameErr) {
        logger.warn(
          { err: renameErr, quarantinePath },
          "[handoff] handoff-state.json 隔离失败（损坏文件仍在原路径，后续 save 可能覆盖它）",
        );
      }
      logger.warn(
        { err: err, quarantinePath, quarantined },
        quarantined
          ? "[handoff] handoff-state.json 损坏，已隔离并以空态启动（不覆盖损坏数据）"
          : "[handoff] handoff-state.json 损坏且隔离失败：以空态启动，原路径损坏文件未被覆盖",
      );
      return [];
    }
    if (!file) return [];
    if (!Array.isArray(file.handoffs)) {
      logger.warn(
        `[handoff] handoff-state.json 缺少 handoffs 数组（按空处理）：${this.store.filePath}`,
      );
      return [];
    }
    return file.handoffs;
  }

  async save(records: HandoffRecord[]): Promise<void> {
    await this.store.writeJson({ handoffs: records });
  }

  /**
   * 启动对账：活跃条目（pending/scheduled/running）一律标 lost——
   * 重启后换班现场已毁，不知死活≠已知失败（同 subagent lost 语义，交人工决策）。
   * 返回标记数量。
   */
  async markActiveAsLost(): Promise<number> {
    const records = await this.loadAll();
    let count = 0;
    for (const record of records) {
      if (isActiveHandoff(record.status)) {
        record.status = "lost";
        record.abortReason = "engine_restart";
        record.updatedAt = Date.now();
        count++;
      }
    }
    if (count > 0) {
      await this.save(records);
      logger.warn(`[handoff] 启动对账：${count} 个活跃换班条目标记为 lost（重启前未完成）`);
    }
    return count;
  }
}

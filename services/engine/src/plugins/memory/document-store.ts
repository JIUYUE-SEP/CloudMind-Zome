import { logger } from "../../logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  CURRENT_SCHEMA_VERSION,
  MigrationChain,
  splitSchemaVersion,
  stampSchemaVersion,
} from "../../versioning.js";

// 写队列挂在模块级、按文件路径串行：
// DocumentStore 实例由调用方随手 new，实例级队列起不到跨调用串行化的作用，
// 必须按文件维度串行才能保证 append/writeLines 的顺序与 tmp 文件不互相踩踏。
const writeQueues = new Map<string, Promise<void>>();

/**
 * 读缓存：JSONL 仓库（messages/memories/actions 等）的读取都是"全量读入再过滤"，
 * 且同一轮对话会对同一文件读多次（如 L3 listBySession + L4 getByIds）。
 * 双重失效：进程内写在三个写路径上主动 delete（同尺寸同 mtime 的写无法靠 stat 区分）；
 * 进程外直写由 (mtimeMs, size) 指纹兜底。命中时省掉整文件的读取+逐行 JSON.parse。
 * 缓存条数按文件数计（很少），体积与文件本身同阶——热存储有界性由话题压缩保证。
 */
const readCache = new Map<string, { mtimeMs: number; size: number; records: object[] }>();

/**
 * Windows 上 rename 覆盖一个正被并发读取（读句柄未释放）的目标文件会 EPERM
 * （典型：scheduler 写回 scheduler.jsonl 时 API/轮询正在 readLines）。
 * 句柄占用是瞬时的，短暂退避重试即可；POSIX 下 rename 本就允许覆盖，一次成功。
 */
export async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (retryable && attempt < 5) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

export class DocumentStore<T extends object> {
  /**
   * @param schema 该文件格式的迁移链（P1-1）：写入时逐行/顶层盖 `schemaVersion`
   * 当前版本戳；读取时无版本字段按 v1、旧版逐级惰性迁移、高于当前版本抛
   * UnsupportedSchemaVersionError。默认 v1 空链（机制就位，格式升级时再注册迁移）。
   */
  constructor(
    public filePath: string,
    private readonly schema: MigrationChain<T> = new MigrationChain<T>(CURRENT_SCHEMA_VERSION),
  ) {}

  private enqueueWrite(op: () => Promise<void>): Promise<void> {
    const prev = writeQueues.get(this.filePath) ?? Promise.resolve();
    const next = prev.then(op, op);
    writeQueues.set(this.filePath, next);
    // 队列尾部 settle 后清理，避免 Map 随文件数无限增长
    const cleanup = () => {
      if (writeQueues.get(this.filePath) === next) writeQueues.delete(this.filePath);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async readJson(): Promise<T | undefined> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > 10 * 1024 * 1024) {
        throw new Error(`JSON file too large: ${this.filePath} (${stat.size} bytes)`);
      }
      const content = await fs.readFile(this.filePath, "utf-8");
      // 版本字段（P1-1）：无 schemaVersion 的旧文件视为 v1；高版本抛错；旧版惰性迁移
      const { version, data } = splitSchemaVersion(JSON.parse(content) as T);
      return this.schema.migrate(data, version, this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async writeJsonInner(data: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const stamped = stampSchemaVersion(data, this.schema.currentVersion);
    await fs.writeFile(tmpPath, JSON.stringify(stamped, null, 2) + "\n");
    await renameWithRetry(tmpPath, this.filePath);
    readCache.delete(this.filePath);
  }

  async writeJson(data: T): Promise<void> {
    await this.enqueueWrite(() => this.writeJsonInner(data));
  }

  private async appendLineInner(record: T): Promise<void> {
    // 每行盖版本戳（P1-1）：append-only 文件升级后必然新旧版本行混排，按行记录版本
    const line = JSON.stringify(stampSchemaVersion(record, this.schema.currentVersion)) + "\n";
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, "utf-8");
    readCache.delete(this.filePath);
  }

  async appendLine(record: T): Promise<void> {
    await this.enqueueWrite(() => this.appendLineInner(record));
  }

  private async writeLinesInner(records: T[]): Promise<void> {
    const content =
      records.map((r) => JSON.stringify(stampSchemaVersion(r, this.schema.currentVersion))).join("\n") +
      (records.length ? "\n" : "");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, content);
    await renameWithRetry(tmpPath, this.filePath);
    readCache.delete(this.filePath);
  }

  async writeLines(records: T[]): Promise<void> {
    await this.enqueueWrite(() => this.writeLinesInner(records));
  }

  /**
   * 原子的"读-改-写"：读取与写回在同一个队列槽内完成，
   * 避免并发 update/delete 之间丢更新（如定时任务删除后被执行器写回复活）。
   * mutator 抛异常时不写入。
   */
  async mutateLines(mutator: (records: T[]) => T[] | Promise<T[]>): Promise<void> {
    await this.enqueueWrite(async () => {
      const records = await this.readLines();
      const next = await mutator(records);
      await this.writeLinesInner(next);
    });
  }

  /**
   * 逐行解析：空行跳过、坏行记日志跳过（JSON 撕裂属崩溃窗口预期内）；
   * 版本检查/迁移放在坏行跳过的 catch 之外——版本过高与迁移失败必须显式上抛。
   */
  private parseRecordLine(line: string): T | undefined {
    if (!line.trim()) return undefined;
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch (err) {
      logger.warn({ err: err }, `Failed to parse JSONL line in ${this.filePath}: ${line}`);
      return undefined;
    }
    const { version, data } = splitSchemaVersion(parsed);
    return this.schema.migrate(data, version, this.filePath);
  }

  /**
   * 流式过滤读：逐行解析、仅保留 predicate 命中的记录，内存占用与文件大小无关。
   * 不设 readLines 的 100MB 尺寸上限、不进读缓存——归档恢复路径（getArchivedByIds）
   * 必须在大于上限的归档上仍可用（review M10：恢复场景恰好排在上限引爆点之后）。
   */
  async readLinesWhere(predicate: (record: T) => boolean): Promise<T[]> {
    const results: T[] = [];
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, "r");
      const stream = handle.createReadStream();
      const rl = createInterface({ input: stream });
      try {
        for await (const line of rl) {
          const record = this.parseRecordLine(line);
          if (record !== undefined && predicate(record)) results.push(record);
        }
      } finally {
        rl.close();
      }
      return results;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    } finally {
      await handle?.close();
    }
  }

  /**
   * 惰性逐行读：逐行解析、按需 yield，内存与文件大小无关，且调用方可随时 break
   * 提前停止（for-await 的 break 会走 iterator.return()，流与句柄在 finally 关闭）。
   * 不进读缓存（缓存是全量驻留语义）——适合跨存储归并分页这类
   * "只取尾部/游标前一段"的场景（如聊天接口读超大归档）。
   */
  async *readLinesLazy(): AsyncGenerator<T, void, void> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, "r");
      const stream = handle.createReadStream();
      const rl = createInterface({ input: stream });
      try {
        for await (const line of rl) {
          const record = this.parseRecordLine(line);
          if (record !== undefined) yield record;
        }
      } finally {
        rl.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    } finally {
      await handle?.close();
    }
  }

  async readLines(options?: { limit?: number; offset?: number }): Promise<T[]> {
    const stat = await fs.stat(this.filePath).catch(() => null);
    if (stat && stat.size > 100 * 1024 * 1024) {
      throw new Error(`File too large: ${this.filePath}`);
    }
    if (!stat) {
      // 文件不存在：同时清掉可能的陈旧缓存，避免删除后复活旧数据
      readCache.delete(this.filePath);
      return [];
    }
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? Infinity;
    const end = limit === Infinity ? undefined : offset + limit;
    const cached = readCache.get(this.filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // 深拷贝：调用方可能原地修改记录（如 scheduler runTask 直接给记录写字段），
      // 缓存对象绝不能与任何一次返回值共享引用，否则内存改动会绕过写路径"污染"后续读取
      return structuredClone((cached.records as T[]).slice(offset, end));
    }
    // 缓存未命中：全量解析并回填缓存，offset/limit 在内存中应用（语义与提前停读一致）
    const results: T[] = [];
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, "r");
      const stream = handle.createReadStream();
      const rl = createInterface({ input: stream });
      try {
        for await (const line of rl) {
          const record = this.parseRecordLine(line);
          if (record !== undefined) results.push(record);
        }
      } finally {
        rl.close();
      }
      readCache.set(this.filePath, { mtimeMs: stat.mtimeMs, size: stat.size, records: results });
      // 同样深拷贝返回：缓存持有 results 本身，返回值必须是独立副本
      return structuredClone(results.slice(offset, end));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    } finally {
      await handle?.close();
    }
  }
}

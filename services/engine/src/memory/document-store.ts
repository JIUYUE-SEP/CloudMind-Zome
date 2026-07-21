import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// 写队列挂在模块级、按文件路径串行：
// DocumentStore 实例由调用方随手 new，实例级队列起不到跨调用串行化的作用，
// 必须按文件维度串行才能保证 append/writeLines 的顺序与 tmp 文件不互相踩踏。
const writeQueues = new Map<string, Promise<void>>();

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
  constructor(public filePath: string) {}

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
      return JSON.parse(content) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async writeJsonInner(data: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n");
    await renameWithRetry(tmpPath, this.filePath);
  }

  async writeJson(data: T): Promise<void> {
    await this.enqueueWrite(() => this.writeJsonInner(data));
  }

  private async appendLineInner(record: T): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, "utf-8");
  }

  async appendLine(record: T): Promise<void> {
    await this.enqueueWrite(() => this.appendLineInner(record));
  }

  private async writeLinesInner(records: T[]): Promise<void> {
    const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, content);
    await renameWithRetry(tmpPath, this.filePath);
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

  async readLines(options?: { limit?: number; offset?: number }): Promise<T[]> {
    const stat = await fs.stat(this.filePath).catch(() => null);
    if (stat && stat.size > 100 * 1024 * 1024) {
      throw new Error(`File too large: ${this.filePath}`);
    }
    const results: T[] = [];
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? Infinity;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, "r");
      const stream = handle.createReadStream();
      const rl = createInterface({ input: stream });
      let skipped = 0;
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          if (skipped < offset) {
            skipped++;
            continue;
          }
          if (results.length >= limit) break;
          try {
            results.push(JSON.parse(line) as T);
          } catch (err) {
            console.error(`Failed to parse JSONL line in ${this.filePath}: ${line}`, err);
          }
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
}

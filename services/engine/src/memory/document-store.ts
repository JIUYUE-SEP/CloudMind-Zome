import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export class DocumentStore<T extends object> {
  constructor(public filePath: string) {}
  private writeQueue: Promise<unknown> = Promise.resolve();

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

  async writeJson(data: T): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n");
      await fs.rename(tmpPath, this.filePath);
    });
    await this.writeQueue;
  }

  async appendLine(record: T): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf-8");
    });
    await this.writeQueue;
  }

  async writeLines(records: T[]): Promise<void> {
    const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, content);
      await fs.rename(tmpPath, this.filePath);
    });
    await this.writeQueue;
  }

  async readLines(options?: { limit?: number; offset?: number }): Promise<T[]> {
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

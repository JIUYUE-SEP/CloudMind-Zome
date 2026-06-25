import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export class DocumentStore<T extends object> {
  constructor(private filePath: string) {}

  async readJson(): Promise<T | undefined> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async writeJson(data: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n");
    await fs.rename(tmpPath, this.filePath);
  }

  async appendLine(record: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(this.filePath, line, "utf-8");
  }

  async writeLines(records: T[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, this.filePath);
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
      for await (const line of rl) {
        if (!line.trim()) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        if (results.length >= limit) break;
        results.push(JSON.parse(line) as T);
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

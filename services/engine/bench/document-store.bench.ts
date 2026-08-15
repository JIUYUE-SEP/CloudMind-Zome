import { bench, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentStore } from "../src/plugins/memory/document-store.js";

interface Record {
  id: string;
  text: string;
  createdAt: string;
}

describe("DocumentStore", () => {
  let tmpDir: string;
  let store: DocumentStore<Record>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-bench-"));
    store = new DocumentStore<Record>(path.join(tmpDir, "records.jsonl"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  bench("append 100 records", async () => {
    for (let i = 0; i < 100; i++) {
      await store.appendLine({
        id: `r${i}`,
        text: "x".repeat(200),
        createdAt: new Date().toISOString(),
      });
    }
  });

  bench("read 1000 records", async () => {
    for (let i = 0; i < 1000; i++) {
      await store.appendLine({
        id: `r${i}`,
        text: "x".repeat(200),
        createdAt: new Date().toISOString(),
      });
    }
    await store.readLines();
  });
});

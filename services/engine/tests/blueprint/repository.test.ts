import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlueprintRepository } from "../../src/blueprint/repository.js";

describe("BlueprintRepository", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bp-test-"));
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.CLOUDMIND_DATA_DIR;
  });

  it("creates and lists blueprints", async () => {
    const repo = new BlueprintRepository();
    await repo.create({ name: "Test", nodes: [], edges: [] });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Test");
  });

  it("gets, updates and deletes a blueprint", async () => {
    const repo = new BlueprintRepository();
    const created = await repo.create({ name: "Test", nodes: [], edges: [] });
    const got = await repo.get(created.id);
    expect(got?.name).toBe("Test");

    got!.name = "Updated";
    await repo.update(got!);
    const updated = await repo.get(created.id);
    expect(updated?.name).toBe("Updated");

    await repo.delete(created.id);
    const list = await repo.list();
    expect(list).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentRepository } from "../../../src/memory/repositories/agent.js";
import { getAgentDir } from "../../../src/config/paths.js";
import type { AgentConfig } from "@mindcloud/shared";
import { restoreDataDir } from "../../helpers/env.js";

describe("AgentRepository", () => {
  let repo: AgentRepository;
  let dataDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-test-"));
    process.env.CLOUDMIND_DATA_DIR = dataDir;
    repo = new AgentRepository();
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const makeConfig = (id: string, name: string): AgentConfig => ({
    id,
    name,
    persona: "p",
    model: "gpt-4",
    skills: [],
    tools: [],
  });

  it("saves and retrieves agent config", async () => {
    const config = makeConfig("agent-1", "Test");
    await repo.save("agent-1", config);
    const got = await repo.get("agent-1");
    expect(got).toEqual(config);
  });

  it("lists agents", async () => {
    await repo.save("a", makeConfig("a", "A"));
    await repo.save("b", makeConfig("b", "B"));
    const list = await repo.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("lists agents skipping corrupted agent.json files", async () => {
    await repo.save("good", makeConfig("good", "Good"));
    const badDir = path.join(dataDir, "agents", "bad");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "agent.json"), "not valid json");

    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("good");
  });

  it("list() backfills id from directory name when agent.json lacks it", async () => {
    const dir = path.join(dataDir, "agents", "no-id-agent");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "agent.json"),
      JSON.stringify({ name: "NoId", persona: "p", model: "gpt-4" }),
    );

    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("no-id-agent");
  });

  it("save() persists the route id into agent.json even when body omits it", async () => {
    const config = makeConfig("ignored", "X");
    await repo.save("file-id", config);
    const raw = JSON.parse(
      await fs.readFile(path.join(dataDir, "agents", "file-id", "agent.json"), "utf-8"),
    );
    expect(raw.id).toBe("file-id");
  });

  it("deletes agent", async () => {
    await repo.save("del", makeConfig("del", "Del"));
    await repo.delete("del");
    const got = await repo.get("del");
    expect(got).toBeUndefined();
    const list = await repo.list();
    expect(list).toHaveLength(0);
  });

  it("rejects invalid agent ids", async () => {
    await expect(repo.save("../bad", makeConfig("bad", "Bad"))).rejects.toThrow();
    await expect(repo.get("")).rejects.toThrow();
  });

  it("notifies cache of external agent.json changes", async () => {
    const config = makeConfig("cached", "Cached");
    await repo.save("cached", config);
    await repo.get("cached");

    const updated = { ...config, name: "Updated" };
    const filePath = path.join(getAgentDir("cached"), "agent.json");
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2) + "\n");

    // Wait for fs.watch to fire and cache to invalidate.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const got = await repo.get("cached");
    expect(got?.name).toBe("Updated");
  });

  it("fires onChange when agent.json is modified externally", async () => {
    const config = makeConfig("watch-cb", "WatchCb");
    await repo.save("watch-cb", config);
    await repo.get("watch-cb");

    const changes: Array<{ agentId: string; config: AgentConfig | null }> = [];
    repo.onChange = (agentId, cfg) => changes.push({ agentId, config: cfg });

    const updated = { ...config, name: "UpdatedByWatch" };
    const filePath = path.join(getAgentDir("watch-cb"), "agent.json");
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2) + "\n");

    // Wait for fs.watch to fire and callback to be invoked.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(changes.length).toBeGreaterThan(0);
    expect(changes[changes.length - 1].agentId).toBe("watch-cb");
    expect(changes[changes.length - 1].config?.name).toBe("UpdatedByWatch");
  });
});

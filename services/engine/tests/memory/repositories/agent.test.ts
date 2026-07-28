import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentRepository } from "../../../src/memory/repositories/agent.js";
import { ErrorThrottle } from "../../../src/scheduler/error-throttle.js";
import { logger } from "../../../src/logger.js";
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

  it("watcher 重载失败节流（P4 Major-1）：文件反复写坏不刷屏，恢复有日志", async () => {
    const now = 0;
    const throttle = new ErrorThrottle({ now: () => now, initialBackoffMs: 1000 });
    const throttledRepo = new AgentRepository({ errorThrottle: throttle });
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const wait = () => new Promise((resolve) => setTimeout(resolve, 300));

    await throttledRepo.save("thr", makeConfig("thr", "T"));
    await throttledRepo.get("thr"); // 建立 watcher
    const filePath = path.join(getAgentDir("thr"), "agent.json");

    // 连续 3 轮"写坏 → 回调报错并 invalidate → 写回有效 → get() 重建 watcher"，
    // 假时钟冻结在同一退避窗口内：只有首轮记 error，其余折叠
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(filePath, "not valid json");
      await wait();
      await fs.writeFile(filePath, JSON.stringify(makeConfig("thr", "T")) + "\n");
      await throttledRepo.get("thr"); // 有效文件：重建 watcher（不恢复 reload 类别）
    }

    const reloadErrors = errorSpy.mock.calls.filter((c) =>
      String(c[1]).includes("Failed to reload agent config"),
    );
    expect(reloadErrors).toHaveLength(1);

    // 恢复：watcher 存活时一次成功解析 → 记一条"已恢复"带累计。
    // fs.watch 每次写入可能触发多个回调（Windows 常见），事件总数不定——
    // 断言节流语义本身：仅首条落日志（suppressed = count - 1），不钉死次数
    await fs.writeFile(filePath, JSON.stringify(makeConfig("thr", "Recovered")) + "\n");
    await wait();
    const recovered = infoSpy.mock.calls.filter((c) => String(c[1]).includes("watcher 已恢复"));
    expect(recovered).toHaveLength(1);
    const recoveredFields = recovered[0]?.[0] as { count: number; suppressed: number };
    expect(recoveredFields.count).toBeGreaterThanOrEqual(3);
    expect(recoveredFields.suppressed).toBe(recoveredFields.count - 1);

    errorSpy.mockRestore();
    infoSpy.mockRestore();
    throttledRepo.dispose();
  });
});

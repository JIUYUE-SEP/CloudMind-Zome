/**
 * handoff-state.json 控制面：
 * ① record：交接书入控制面（稳定 id、agent+session 维度单条目、文件落盘）；
 * ② markStatus 状态机（scheduled/running/completed/fused 清 resumeJobId）；
 * ③ cancel/abort：活跃条目标 aborted + 原因；
 * ④ load 启动对账：活跃条目标 lost（重启不自动续跑）；
 * ⑤ list/activeFor 查询。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HandoffManager } from "../../src/handoff/manager.js";
import { HandoffStateStore } from "../../src/handoff/state.js";
import type { HandoffBookInfo } from "../../src/handoff/types.js";
import { restoreDataDir } from "../helpers/env.js";

function bookInfo(overrides: Partial<HandoffBookInfo> = {}): HandoffBookInfo {
  return {
    agentId: "a1",
    sessionId: "s1",
    reason: "watermark",
    shift: 1,
    maxShifts: 3,
    used: 950,
    window: 1000,
    bookMessageId: "msg_book",
    bookText: "[交接书] 换班移交（第 1/3 棒）",
    ...overrides,
  };
}

let tmpDir: string;
let originalDataDir: string | undefined;
let store: HandoffStateStore;
let manager: HandoffManager;
const updates: string[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-manager-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  store = new HandoffStateStore(path.join(tmpDir, "handoff-state.json"));
  updates.length = 0;
  manager = new HandoffManager({
    store,
    onUpdate: (record) => updates.push(`${record.id}:${record.status}:${record.shift}`),
  });
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("HandoffManager 控制面", () => {
  it("record：交接书入控制面并落盘（同一 agent+session 复用 id，新棒覆盖旧棒）", async () => {
    const r1 = await manager.record(bookInfo());
    expect(r1).toMatchObject({ id: "ho_a1_s1", status: "pending", shift: 1, bookText: expect.stringContaining("[交接书]") });

    // 换棒：同 id、shift 递增、createdAt 保留、abortReason 清掉
    await manager.markStatus(r1.id, "aborted", { abortReason: "user_message" });
    const r2 = await manager.record(bookInfo({ shift: 2 }));
    expect(r2.id).toBe("ho_a1_s1");
    expect(r2.shift).toBe(2);
    expect(r2.createdAt).toBe(r1.createdAt);
    expect(r2.abortReason).toBeUndefined();

    const onDisk = await store.loadAll();
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.shift).toBe(2);
  });

  it("markStatus 状态机：fused/completed 清 resumeJobId", async () => {
    const r = await manager.record(bookInfo());
    await manager.markStatus(r.id, "running", { resumeJobId: "job_1" });
    expect(manager.get(r.id)!.resumeJobId).toBe("job_1");
    await manager.markStatus(r.id, "fused");
    expect(manager.get(r.id)).toMatchObject({ status: "fused" });
    expect(manager.get(r.id)!.resumeJobId).toBeUndefined();
  });

  it("markStatus 非法转移抛错且状态不变（终态不可再转移）", async () => {
    const r = await manager.record(bookInfo());
    await manager.cancel("a1", "s1", "user_message");
    // aborted → completed 是 P1-1 曾发生的覆盖路径，现在被转移表拦下
    await expect(manager.markStatus(r.id, "completed")).rejects.toThrow(
      /invalid handoff transition: aborted -> completed/,
    );
    expect(manager.get(r.id)).toMatchObject({ status: "aborted", abortReason: "user_message" });

    const done = await manager.record(bookInfo({ agentId: "a2", sessionId: "s2", shift: 2 }));
    await manager.markStatus(done.id, "scheduled");
    await manager.markStatus(done.id, "running");
    await manager.markStatus(done.id, "completed");
    await expect(manager.markStatus(done.id, "scheduled")).rejects.toThrow(
      /invalid handoff transition: completed -> scheduled/,
    );
    expect(manager.get(done.id)).toMatchObject({ status: "completed" });
  });

  it("cancel：用户消息打断 → 活跃条目标 aborted + 原因；非活跃不变", async () => {
    const r = await manager.record(bookInfo());
    await manager.markStatus(r.id, "scheduled");
    const cancelled = await manager.cancel("a1", "s1", "user_message");
    expect(cancelled).toHaveLength(1);
    expect(manager.get(r.id)).toMatchObject({ status: "aborted", abortReason: "user_message" });

    // 已终态再 cancel 是空操作
    expect(await manager.cancel("a1", "s1", "user_message")).toEqual([]);
  });

  it("abort：手动打断（REST）同语义，未知 id 返回 undefined", async () => {
    const r = await manager.record(bookInfo());
    const updated = await manager.abort(r.id, "manual");
    expect(updated).toMatchObject({ status: "aborted", abortReason: "manual" });
    expect(await manager.abort("ho_ghost")).toBeUndefined();
  });

  it("load 启动对账：活跃条目标 lost（重启后不自动续跑），终态条目保留", async () => {
    const active = await manager.record(bookInfo());
    const done = await manager.record(bookInfo({ agentId: "a2", sessionId: "s2", shift: 2 }));
    await manager.markStatus(done.id, "scheduled");
    await manager.markStatus(done.id, "running");
    await manager.markStatus(done.id, "completed");

    // 模拟重启：新 manager 从同一 store 加载
    const restarted = new HandoffManager({ store });
    await restarted.load();
    expect(restarted.get(active.id)).toMatchObject({ status: "lost", abortReason: "engine_restart" });
    expect(restarted.get(done.id)).toMatchObject({ status: "completed" });
  });

  it("A3：损坏的 handoff-state.json 被隔离为 .corrupt-*，以空态启动不崩", async () => {
    const filePath = path.join(tmpDir, "handoff-state.json");
    await fs.writeFile(filePath, "{ this is not json", "utf-8");

    const brokenStore = new HandoffStateStore(filePath);
    expect(await brokenStore.loadAll()).toEqual([]);

    // 隔离文件生成：原文件被重命名（不覆盖损坏数据），后续 save 重建干净文件
    const files = await fs.readdir(tmpDir);
    const corrupt = files.find((f) => f.startsWith("handoff-state.json.corrupt-"));
    expect(corrupt).toBeDefined();
    await expect(fs.access(filePath)).rejects.toThrow();

    // 新 manager 从空态加载不崩、可继续 record/save（空态 loadAll 返回空）
    const restarted = new HandoffManager({ store: brokenStore });
    await expect(restarted.load()).resolves.toBeUndefined();
    expect(restarted.list()).toEqual([]);
    const r = await restarted.record(bookInfo());
    expect(restarted.get(r.id)).toMatchObject({ status: "pending", shift: 1 });
  });

  it("list/activeFor 查询", async () => {
    await manager.record(bookInfo());
    await manager.record(bookInfo({ agentId: "a2", sessionId: "s2", shift: 2 }));
    expect(manager.list()).toHaveLength(2);
    expect(manager.list({ agentId: "a1" })).toHaveLength(1);
    expect(manager.list({ agentId: "a1", sessionId: "s1" })[0]!.id).toBe("ho_a1_s1");
    expect(manager.activeFor("a1", "s1")?.status).toBe("pending");
    await manager.cancel("a1", "s1", "user_message");
    expect(manager.activeFor("a1", "s1")).toBeUndefined();
  });

  it("状态变化经 onUpdate 通知（含落盘成功才通知）", async () => {
    const r = await manager.record(bookInfo());
    await manager.markStatus(r.id, "scheduled");
    await manager.markStatus(r.id, "running");
    expect(updates).toEqual(["ho_a1_s1:pending:1", "ho_a1_s1:scheduled:1", "ho_a1_s1:running:1"]);
  });
});

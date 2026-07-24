import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "@mindcloud/shared";
import {
  clearTopicState,
  loadTopicState,
  saveTopicState,
} from "../../src/memory/topic/state.js";
import { TopicTracker } from "../../src/memory/topic/tracker.js";
import { restoreDataDir } from "../helpers/env.js";

function msg(id: string, role: "user" | "assistant", createdAt: string): ChatMessage {
  return { id, role, content: [{ type: "text", text: `消息 ${id}` }], createdAt };
}

function at(min: number): string {
  return new Date(Date.parse("2026-07-24T10:00:00.000Z") + min * 60_000).toISOString();
}

describe("topic-state 落盘（P1-2）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-state-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  it("save/load roundtrip，文件带 P1-1 版本字段", async () => {
    await saveTopicState("a1", {
      messageIds: ["m1", "m2"],
      startedAt: at(0),
      sourceId: "s1",
      sourceName: "私聊",
    });
    const raw = JSON.parse(
      await fs.readFile(path.join(tmpDir, "agents", "a1", "topic-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);

    expect(await loadTopicState("a1")).toEqual({
      open: { messageIds: ["m1", "m2"], startedAt: at(0), sourceId: "s1", sourceName: "私聊" },
    });
  });

  it("open=null 表示无未关闭话题；clearTopicState 删除状态文件", async () => {
    await saveTopicState("a1", null);
    expect(await loadTopicState("a1")).toEqual({ open: null });

    await clearTopicState("a1");
    expect(await loadTopicState("a1")).toBeUndefined();
    // 重复清除安全
    await clearTopicState("a1");
  });

  it("无状态文件时 load 返回 undefined", async () => {
    expect(await loadTopicState("ghost")).toBeUndefined();
  });
});

describe("TopicTracker 开放话题快照（P1-2）", () => {
  const config = { enabled: true, windowMinutes: 30, messageThreshold: 5 };

  it("快照随话题累积更新，达到阈值关闭后清空", () => {
    const tracker = new TopicTracker(config);

    expect(tracker.openTopic).toBeNull();
    tracker.onUserMessage(msg("u1", "user", at(0)), "s1");
    expect(tracker.openTopic).toMatchObject({ messageIds: ["u1"], startedAt: at(0), sourceId: "s1" });

    tracker.onTurnAppended([msg("a1", "assistant", at(1))], "s1");
    expect(tracker.openTopic?.messageIds).toEqual(["u1", "a1"]);

    // 累积到 5 条（阈值）→ onTurnAppended 关闭话题 → 快照清空
    tracker.onTurnAppended(
      [msg("a2", "assistant", at(2)), msg("a3", "assistant", at(3)), msg("a4", "assistant", at(4))],
      "s1",
    );
    expect(tracker.openTopic).toBeNull();
  });

  it("enabled=false 时快照恒为 null", () => {
    const tracker = new TopicTracker({ ...config, enabled: false });
    tracker.onUserMessage(msg("u1", "user", at(0)), "s1");
    tracker.onTurnAppended([msg("a1", "assistant", at(1))], "s1");
    expect(tracker.openTopic).toBeNull();
  });
});

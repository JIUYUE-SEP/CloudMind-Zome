import { logger } from "../../src/logger.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 模拟 Windows 上 rename 持久失败（文件被占用超过重试窗口）：只拦 renameWithRetry，
// 其余 document-store 行为保持真实
vi.mock("../../src/memory/document-store.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/memory/document-store.js")>();
  return {
    ...actual,
    renameWithRetry: vi.fn(async () => {
      throw new Error("EPERM: operation not permitted, rename (file locked)");
    }),
  };
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendMindExperiences,
  type NewMindExperience,
} from "../../src/mind/mind-files.js";
import { getAgentDir } from "../../src/config/paths.js";
import { restoreDataDir } from "../helpers/env.js";

const AGENT_ID = "mind-sidecar";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-sidecar-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  restoreDataDir(originalDataDir);
  vi.restoreAllMocks();
});

function agentDir(): string {
  return getAgentDir(AGENT_ID);
}

function exp(overrides: Partial<NewMindExperience> = {}): NewMindExperience {
  return {
    title: "指挥官偏好：不用 emoji",
    text: "指挥官明确表示不使用 emoji。",
    confidence: 0.9,
    source: "topic-tp_1",
    created: "2026-07-23T17:00:00Z",
    ...overrides,
  };
}

describe("MIND.md 写入失败 sidecar（review Minor-1）", () => {
  it("rename 持久失败：不抛错、整批落 sidecar JSONL、MIND.md 原内容不变、warn 带路径", async () => {
    const seed = "我是新心智，还在学习中。\n";
    await fs.mkdir(agentDir(), { recursive: true });
    await fs.writeFile(path.join(agentDir(), "MIND.md"), seed, "utf-8");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await appendMindExperiences(AGENT_ID, [
      exp(),
      exp({ title: "Windows 进程管理", text: "杀 node 会连带 engine。" }),
    ]);

    // 主文件保持原样（rename 全部失败）
    expect(await fs.readFile(path.join(agentDir(), "MIND.md"), "utf-8")).toBe(seed);

    // sidecar 落盘：每行一个可解析 JSON，含 frontmatter 各字段
    const sidecarPath = path.join(agentDir(), "mind-failed.jsonl");
    const lines = (await fs.readFile(sidecarPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      title: "指挥官偏好：不用 emoji",
      text: "指挥官明确表示不使用 emoji。",
      confidence: 0.9,
      source: "topic-tp_1",
      created: "2026-07-23T17:00:00Z",
    });
    expect(lines[0].failedAt).toBeTruthy();
    // P1-1：JSONL 落盘格式按行带版本字段
    expect(lines[0].schemaVersion).toBe(1);
    expect(lines[1].title).toBe("Windows 进程管理");

    // warn 留痕且带 sidecar 路径（支持人工恢复）；P4-1 起 err 为合并首参，路径在 msg 参数
    const warnText = warn.mock.calls.map((c) => String(c[1] ?? c[0])).join("\n");
    expect(warnText).toContain("mind-failed.jsonl");
  });

  it("sidecar 也写失败（路径是目录）：仍不抛错", async () => {
    await fs.mkdir(path.join(agentDir(), "mind-failed.jsonl"), { recursive: true });
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(appendMindExperiences(AGENT_ID, [exp()])).resolves.toBeTruthy();
  });
});

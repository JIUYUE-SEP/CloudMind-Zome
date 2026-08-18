/**
 * F4 启动期重试单测（真实子进程，fake 退避间隔）：
 * 1) 启动失败后低频退避重试，第 N 次连上即补工具注册 + info 日志；
 * 2) close() 清重试定时器，关停后不再发起任何重连；
 * 3) 退避 ×2 封顶不无限增长；重复失败经 ErrorThrottle 折叠（不逐次刷 warn）。
 * CLOUDMIND_DATA_DIR 不涉及（manager 直接构造）；计数文件落临时目录。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClientManager } from "../../../src/tools/mcp/client-manager.js";
import { logger } from "../../../src/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const flakyFixture = path.join(__dirname, "fixtures", "flaky-server.ts");

/** 测试注入的退避节奏：30ms 起步 ×2 封顶 60ms（生产 30s/5min 的加速版） */
const RETRY_OPTS = { startupRetryInitialMs: 30, startupRetryMaxMs: 60 };

let tmpDir: string;

async function makeManager(failTimes: number): Promise<McpClientManager> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-startup-retry-"));
  return new McpClientManager(
    [
      {
        name: "flaky",
        command: "node",
        args: ["--import", "tsx", flakyFixture],
        env: {
          FLAKY_COUNTER_FILE: path.join(tmpDir, "counter.log"),
          FLAKY_FAIL_TIMES: String(failTimes),
        },
      },
    ],
    RETRY_OPTS,
  );
}

/** 读计数文件：每行 `<次数>:<epoch-ms>` */
function attempts(): { count: number; at: number }[] {
  const file = path.join(tmpDir, "counter.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((line) => {
      const [count, at] = line.split(":");
      return { count: Number(count), at: Number(at) };
    });
}

afterEach(async () => {
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("McpClientManager 启动期重试（F4）", () => {
  it("启动失败后退避重试，连上即补工具注册并记 info，连上即停", async () => {
    const manager = await makeManager(2); // 前 2 次启动必败，第 3 次（重试 #2）成功
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await manager.connectAll();
      // 启动即败：降级不抛出、工具列表为空
      expect(manager.getTools()).toEqual([]);

      // 退避重试连上后补注册（快照注入是 live flatMap，注册自动可见）
      await vi.waitFor(
        () => {
          expect(manager.getTools().map((t) => t.name)).toContain("mcp__flaky__echo");
        },
        { timeout: 15_000, interval: 50 },
      );
      expect(info.mock.calls.map((c) => String(c.at(-1))).join("\n")).toContain(
        "[mcp] server flaky 已连接",
      );

      // 连上即停：再等远超退避间隔的时间，不得有新的启动尝试
      await new Promise((r) => setTimeout(r, 300));
      expect(attempts()).toHaveLength(3);
      await manager.close();
    } finally {
      info.mockRestore();
    }
  }, 30_000);

  it("close() 清重试定时器：关停后不再发起任何重连", async () => {
    const manager = await makeManager(999); // 永远失败
    await manager.connectAll();
    // 至少等到第一次重试触发（证明重试循环确实在跑）
    await vi.waitFor(() => expect(attempts().length).toBeGreaterThanOrEqual(2), {
      timeout: 15_000,
      interval: 50,
    });

    await manager.close();
    const atClose = attempts().length;
    // 等远超退避封顶（60ms）的时间：定时器若未清，计数必涨
    await new Promise((r) => setTimeout(r, 400));
    expect(attempts().length).toBe(atClose);
  }, 30_000);

  it("退避 ×2 封顶：间隔不无限增长；重复失败告警被节流折叠", async () => {
    const manager = await makeManager(999);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await manager.connectAll();
      // 聚齐 8 次尝试：不封顶时间隔会 ×2 无界增长（30,60,120,240,...），
      // 封顶 60ms 时后段间隔应与首段持平（间隔含约等长的 spawn 失败耗时）
      await vi.waitFor(() => expect(attempts().length).toBeGreaterThanOrEqual(8), {
        timeout: 25_000,
        interval: 50,
      });
      const gaps = attempts()
        .map((a) => a.at)
        .slice(1)
        .map((at, i) => at - attempts()[i].at);
      // 末段间隔 < 首段间隔 ×1.5：未封顶时第 7 间隔 ≥ 首段的 3 倍以上
      expect(gaps[gaps.length - 1]).toBeLessThan(gaps[0] * 1.5);

      // 节流：重试期反复失败只产出首条 warn（窗口 5min，测试时长内全折叠）；
      // connectAll 的首次失败走的是另一条「连接失败，按不可用降级」文案
      const retryWarns = warn.mock.calls.filter((c) =>
        String(c.at(-1)).includes("启动后重试仍未连上"),
      );
      expect(retryWarns).toHaveLength(1);
      await manager.close();
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});

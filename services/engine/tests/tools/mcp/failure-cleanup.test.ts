/**
 * 失败路径回归护栏：
 * 1) connect 失败/超时后，已 spawn 的子进程必须被回收，entry 降级为 unavailable；
 * 2) 坏 mcp-servers.json 时 loadDefault 按空配置降级，不抛出、无可用工具。
 * CLOUDMIND_DATA_DIR 指向临时目录，不污染真实数据目录。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClientManager } from "../../../src/tools/mcp/client-manager.js";
import { restoreDataDir } from "../../helpers/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hangFixture = path.join(__dirname, "fixtures", "hang-server.ts");

describe("McpClientManager 失败路径", () => {
  it("connect 超时失败后子进程被回收，不暴露任何工具", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-fail-"));
    const pidfile = path.join(tmpDir, "hang.pid");
    try {
      // 假 server 永不完成 MCP 握手，connect 走 15s 超时降级路径
      const manager = new McpClientManager([
        { name: "hang", command: "node", args: ["--import", "tsx", hangFixture, pidfile] },
      ]);
      await manager.connectAll();

      // 单 server 失败降级：不抛出、无可用工具
      expect(manager.getTools()).toEqual([]);

      // 子进程已写入 pid；回收后 process.kill(pid, 0) 必须抛 ESRCH
      const pid = Number(fs.readFileSync(pidfile, "utf-8"));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();

      await manager.close();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("McpClientManager.loadDefault 坏配置降级", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-load-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("坏 mcp-servers.json 按空配置降级：不抛出、无可用工具", async () => {
    fs.writeFileSync(path.join(tmpDir, "mcp-servers.json"), "{ 这不是合法 JSON");

    const manager = McpClientManager.loadDefault();
    await manager.connectAll();

    expect(manager.getTools()).toEqual([]);
    await manager.close();
  });
});

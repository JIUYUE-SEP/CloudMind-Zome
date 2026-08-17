/**
 * 失败路径回归护栏：
 * 1) connect 失败/超时后，已 spawn 的子进程必须被回收，entry 降级为 unavailable；
 * 2) 坏 mcp-servers.json 时 loadDefault 降级：整体 JSON 损坏按空配置，
 *    单条非法 server 配置只跳过该条（逐条校验，不拖垮好配置）。
 * CLOUDMIND_DATA_DIR 指向临时目录，不污染真实数据目录。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClientManager } from "../../../src/tools/mcp/client-manager.js";
import { logger } from "../../../src/logger.js";
import { restoreDataDir } from "../../helpers/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hangFixture = path.join(__dirname, "fixtures", "hang-server.ts");
const echoFixture = path.join(__dirname, "fixtures", "echo-server.ts");

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

  it("单条非法配置只跳过该条：合法 server 保留，warn 带下标且不泄漏 env 值", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "mcp-servers.json"),
      JSON.stringify({
        servers: [
          { name: "good", command: "node", args: ["--import", "tsx", echoFixture] },
          // command 非字符串 → 非法；env 携带敏感值，warn 不得落盘
          { name: "leaky", command: 123, env: { TOKEN: "supersecret-token" } },
          "not-an-object",
        ],
      }),
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const manager = McpClientManager.loadDefault();
      await manager.connectAll();

      // H4：只有合法条目进入 manager（旧整体 parse 行为下好配置全丢）
      const names = manager.getTools().map((t) => t.name);
      expect(names).toContain("mcp__good__echo");
      expect(names.some((n) => n.startsWith("mcp__leaky__"))).toBe(false);

      const messages = warn.mock.calls.map((c) => String(c.at(-1))).join("\n");
      expect(messages).toContain("第 1 条");
      expect(messages).toContain("name=leaky");
      expect(messages).toContain("第 2 条");
      expect(messages).not.toContain("supersecret-token");
      await manager.close();
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it("servers 字段缺失/非数组按空配置处理", async () => {
    fs.writeFileSync(path.join(tmpDir, "mcp-servers.json"), JSON.stringify({ servers: "oops" }));
    const manager = McpClientManager.loadDefault();
    await manager.connectAll();
    expect(manager.getTools()).toEqual([]);
    await manager.close();

    fs.writeFileSync(path.join(tmpDir, "mcp-servers.json"), JSON.stringify({}));
    const manager2 = McpClientManager.loadDefault();
    expect(manager2.getTools()).toEqual([]);
    await manager2.close();
  });
});

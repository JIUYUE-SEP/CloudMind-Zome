import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { restoreDataDir } from "../helpers/env.js";
import { __resetAuthTokenCacheForTests } from "../../src/config/auth-token.js";
import * as logPlugin from "../../src/plugins/log/index.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import * as llmPlugin from "../../src/plugins/llm/index.js";
import * as toolsPlugin from "../../src/plugins/tools/index.js";
import * as skillsPlugin from "../../src/plugins/skills/index.js";
import * as memoryPlugin from "../../src/plugins/memory/index.js";
import * as mindPlugin from "../../src/plugins/mind/index.js";
import * as pipelinePlugin from "../../src/plugins/pipeline/index.js";
import * as computePlugin from "../../src/plugins/compute/index.js";
import * as agentsPlugin from "../../src/plugins/agents/index.js";
import * as conductorPlugin from "../../src/plugins/conductor/index.js";
import * as blueprintPlugin from "../../src/plugins/blueprint/index.js";
import * as handoffPlugin from "../../src/plugins/handoff/index.js";
import * as plansPlugin from "../../src/plugins/plans/index.js";
import * as perceptionPlugin from "../../src/plugins/perception/index.js";
import * as intermindPlugin from "../../src/plugins/intermind/index.js";
import * as subagentsPlugin from "../../src/plugins/subagents/index.js";
import * as sidecarPlugin from "../../src/plugins/sidecar/index.js";
import * as httpPlugin from "../../src/plugins/http/index.js";

// P9 http 插件挂载测试：inject 全消费面 PENDING 语义 + ctx.http 面上架 +
// 真 listen 冒烟（listen 前 token 就绪/落盘语义、/health 免鉴权、REST 401/200、
// dispose 子 fiber 收回 app.close、listen 只调一次防御）。
// 挂载链同 bootstrap 序（缺 scheduler/invariants——http 不 inject 它们）。
describe("plugins/http（P9）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  let originalPort: string | undefined;
  let originalAuthToken: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "http-plugin-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
    originalPort = process.env.PORT;
    originalAuthToken = process.env.CLOUDMIND_AUTH_TOKEN;
    // 走 auth-token 文件路径（listen 前就绪/落盘语义的本体）
    delete process.env.CLOUDMIND_AUTH_TOKEN;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalAuthToken === undefined) delete process.env.CLOUDMIND_AUTH_TOKEN;
    else process.env.CLOUDMIND_AUTH_TOKEN = originalAuthToken;
    __resetAuthTokenCacheForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const agentsConfig = {
    getSubagentServices: () => ({
      subagentDispatcher: {} as never,
      subagentSwarm: {} as never,
      puppetModelService: {} as never,
      intermindService: {} as never,
    }),
    getSidecar: () => ({} as never),
  };

  /** http 全 inject 依赖挂载（bootstrap 序；scheduler/invariants 非依赖不挂） */
  async function mountDeps(ctx: Context): Promise<void> {
    await ctx.plugin(logPlugin);
    await ctx.plugin(configPlugin);
    await ctx.plugin(llmPlugin);
    await ctx.plugin(toolsPlugin);
    await ctx.plugin(memoryPlugin);
    await ctx.plugin(mindPlugin);
    await ctx.plugin(pipelinePlugin);
    await ctx.plugin(computePlugin);
    await ctx.plugin(conductorPlugin);
    await ctx.plugin(blueprintPlugin);
    await ctx.plugin(handoffPlugin);
    await ctx.plugin(sidecarPlugin);
    await ctx.plugin(skillsPlugin, { getAgentConfig: async () => undefined });
    await ctx.plugin(agentsPlugin, agentsConfig);
    await ctx.plugin(plansPlugin);
    await ctx.plugin(perceptionPlugin);
    await ctx.plugin(intermindPlugin);
    await ctx.plugin(subagentsPlugin);
  }

  /** 向 OS 要一个空闲端口（探后即放，竞态窗口可忽略） */
  async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  it("插件元数据：name / inject 全消费面 / apply 四件套可读", () => {
    expect(httpPlugin.name).toBe("http");
    expect(httpPlugin.inject).toEqual([
      "agents",
      "memory",
      "conductor",
      "blueprint",
      "plans",
      "subagents",
      "handoff",
      "intermind",
      "skills",
      "tools",
      "mind",
      "compute",
      "config",
      "sidecar",
    ]);
    expect(typeof httpPlugin.apply).toBe("function");
  });

  it("inject 全消费面未就位时不激活（PENDING）", async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(httpPlugin);
    // cordis rc.8：await fiber 对 PENDING 立即落定，激活与否看 fiber.state（PENDING=0）
    await fiber;
    expect(fiber.state).toBe(0);
    expect(ctx.get("http")).toBeUndefined();
  });

  it("ctx.http 面上架：listen() 真监听——listen 前 token 就绪落盘，dispose 子 fiber 收回", async () => {
    const port = await getFreePort();
    process.env.PORT = String(port);
    const ctx = new Context();
    await mountDeps(ctx);
    const httpFiber = await ctx.plugin(httpPlugin);

    await ctx.http.listen();

    // token 就绪语义：listen() 落定前 auth-token 已生成并落盘（竞态窗口不存在）
    const token = (await fs.readFile(path.join(tempDir, "auth-token"), "utf-8")).trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // 真 listen：/health 免鉴权；REST 无 token 401、带 token 200
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const noAuth = await fetch(`http://127.0.0.1:${port}/agents`);
    expect(noAuth.status).toBe(401);
    const withAuth = await fetch(`http://127.0.0.1:${port}/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withAuth.status).toBe(200);

    // listen 只调一次（组合根契约）：重复调用防御性报错
    await expect(ctx.http.listen()).rejects.toThrow(/重复调用/);

    // app.close() 挂 fiber effect disposer：dispose 子 fiber 即收回监听
    await httpFiber.dispose();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("H9：listen 后 engine.pid 落盘（内容=进程 pid，0o600），dispose 后删除", async () => {
    const port = await getFreePort();
    process.env.PORT = String(port);
    const ctx = new Context();
    await mountDeps(ctx);
    const httpFiber = await ctx.plugin(httpPlugin);

    await ctx.http.listen();

    const pidFile = path.join(tempDir, "engine.pid");
    const content = (await fs.readFile(pidFile, "utf-8")).trim();
    expect(content).toBe(String(process.pid));
    // 权限收紧（同 auth-token 口径）；Windows 忽略 mode 不断言
    if (process.platform !== "win32") {
      const stat = await fs.stat(pidFile);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    // dispose 子 fiber：disposer best-effort 删除 pidfile
    await httpFiber.dispose();
    await expect(fs.access(pidFile)).rejects.toThrow();
  });
});

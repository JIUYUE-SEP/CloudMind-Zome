import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { logger } from "../../src/logger.js";
import * as externalPlugin from "../../src/plugins/external/index.js";
import type { AgentsFace } from "../../src/plugins/agents/index.js";

// 迁移第二阶段 E2：external 插件 per-agent 器官清单
// （DATA_DIR/agents/<id>/plugins.yml，与 SOUL.md 同级）测试。
// harness 形态同 external.test.ts（E1）：临时目录当 DATA_DIR，fixture 插件
// （index.mjs 纯 JS ESM）现场写盘，fixture 侧效果经 globalThis.__ext 通道断言；
// agents 面为最小 stub（agentRepository.list() 返回给定 id 序列），agent 目录
// 与 plugins.yml 在临时 DATA_DIR 下真实落盘（清单解析走真实文件读取）。

/** fixture 侧效果记录通道（beforeEach 重置；calls 供多次挂载记账） */
type FixtureState = Record<string, { config?: unknown }> & { calls?: unknown[] };
const g = globalThis as { __ext?: FixtureState };

describe("plugins/external（E2：per-agent 器官清单 plugins.yml）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-agent-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
    g.__ext = {};
    // 拦截 pino 输出（不污染测试输出与 /logs 环形缓冲）；warn 经 warnText() 断言
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** 全部 warn 调用参数拼一处（断言 includes / 为空） */
  function warnText(): string {
    return (logger.warn as unknown as Mock).mock.calls.map((args) => args.map(String).join(" ")).join("\n");
  }

  /** 现场写 fixture 插件：DATA_DIR/plugins/<dir>/index.mjs */
  async function writePlugin(dir: string, code: string): Promise<void> {
    const pluginDir = path.join(tempDir, "plugins", dir);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "index.mjs"), code);
  }

  /** 建 agent 目录（agents/<id>/）；yaml 提供时写 plugins.yml 正文 */
  async function writeAgentDir(id: string, yaml?: string): Promise<void> {
    const agentDir = path.join(tempDir, "agents", id);
    await fs.mkdir(agentDir, { recursive: true });
    if (yaml !== undefined) {
      await fs.writeFile(path.join(agentDir, "plugins.yml"), yaml);
    }
  }

  /** 直挂 root Context（agents 面 stub：list() 返回给定 id 序列）并等骨架落定 */
  async function mount(agentIds: string[] = []): Promise<Context> {
    const ctx = new Context();
    ctx.provide("agents", {
      agentRepository: { list: async () => agentIds.map((id) => ({ id })) },
    } as unknown as AgentsFace);
    await ctx.plugin(externalPlugin);
    return ctx;
  }

  /** 记录型 fixture：apply 把收到的 config 按插件名写进通道 */
  const recordPlugin = (name: string): string => `
export const name = ${JSON.stringify(name)};
export function apply(ctx, config) {
  globalThis.__ext[${JSON.stringify(name)}] = { config };
}
`;

  /** 多次挂载记账 fixture：每次 apply 把 config 推进 calls 数组 */
  const callsPlugin = (name: string): string => `
export const name = ${JSON.stringify(name)};
export function apply(ctx, config) {
  (globalThis.__ext.calls ??= []).push(config);
}
`;

  it("(agent × plugin) 挂载：两个 agent × 一个插件，各自收到带 agentId 的 config，apply 调两次互不干扰", async () => {
    await writePlugin("shared", callsPlugin("shared"));
    await writeAgentDir("agent-a", "plugins:\n  shared:\n    config:\n      key: value\n");
    await writeAgentDir("agent-b", "plugins:\n  shared: {}\n");

    const ctx = await mount(["agent-a", "agent-b"]);

    // face perAgent：agent 枚举序 × 清单序
    expect(ctx.external.perAgent).toEqual([
      { agentId: "agent-a", name: "shared", status: "loaded" },
      { agentId: "agent-b", name: "shared", status: "loaded" },
    ]);
    // 各自独立挂载：config = { ...manifestConfig, agentId }
    expect(g.__ext?.calls).toEqual([{ key: "value", agentId: "agent-a" }, { agentId: "agent-b" }]);
  });

  it("清单解析：缺省值——enabled 缺省 true、config 缺省 {}（注入 agentId 后只剩 agentId）", async () => {
    await writePlugin("defaults", recordPlugin("defaults"));
    await writeAgentDir("agent-a", "plugins:\n  defaults: {}\n");

    const ctx = await mount(["agent-a"]);

    expect(ctx.external.perAgent).toEqual([{ agentId: "agent-a", name: "defaults", status: "loaded" }]);
    expect(g.__ext?.defaults?.config).toEqual({ agentId: "agent-a" });
  });

  it("清单解析：enabled:false → 不挂载（perAgent 记 disabled）", async () => {
    await writePlugin("off", recordPlugin("off"));
    await writeAgentDir("agent-a", "plugins:\n  off:\n    enabled: false\n");

    const ctx = await mount(["agent-a"]);

    expect(ctx.external.perAgent).toEqual([{ agentId: "agent-a", name: "off", status: "disabled" }]);
    expect(g.__ext?.off).toBeUndefined(); // apply 未执行
  });

  it("清单解析：UTF-8 BOM 剥除后正常加载", async () => {
    await writePlugin("bom-ok", recordPlugin("bom-ok"));
    await writeAgentDir("agent-a", "\uFEFFplugins:\n  bom-ok: {}\n");

    const ctx = await mount(["agent-a"]);

    expect(ctx.external.perAgent).toEqual([{ agentId: "agent-a", name: "bom-ok", status: "loaded" }]);
    expect(warnText()).toBe("");
  });

  it("清单解析：坏 YAML → warn + 该 agent 跳过，不阻断其余 agent", async () => {
    await writePlugin("good", recordPlugin("good"));
    await writeAgentDir("agent-bad", "plugins:\n  broken: [unclosed\n");
    await writeAgentDir("agent-good", "plugins:\n  good: {}\n");

    const ctx = await mount(["agent-bad", "agent-good"]);

    expect(ctx.external.perAgent).toEqual([{ agentId: "agent-good", name: "good", status: "loaded" }]);
    expect(warnText()).toContain("plugins.yml");
    expect(warnText()).toContain("agent-bad");
  });

  it("清单解析：plugins.yml 缺失 → 该 agent 静默跳过（不 warn）", async () => {
    await writeAgentDir("agent-none"); // 只有目录，无 plugins.yml

    const ctx = await mount(["agent-none"]);

    expect(ctx.external.perAgent).toEqual([]);
    expect(warnText()).toBe("");
  });

  it("清单解析：plugins 字段非对象 → warn + 按空清单（该 agent 跳过）", async () => {
    await writeAgentDir("agent-a", 'plugins: "not-a-map"\n');

    const ctx = await mount(["agent-a"]);

    expect(ctx.external.perAgent).toEqual([]);
    expect(warnText()).toContain("agent-a");
    expect(warnText()).toContain("plugins.yml");
  });

  it("混合：无清单 agent 静默跳过，有清单 agent 正常挂载", async () => {
    await writePlugin("only-b", recordPlugin("only-b"));
    await writeAgentDir("agent-a"); // 无清单
    await writeAgentDir("agent-b", "plugins:\n  only-b: {}\n");

    const ctx = await mount(["agent-a", "agent-b"]);

    expect(ctx.external.perAgent).toEqual([{ agentId: "agent-b", name: "only-b", status: "loaded" }]);
    expect(warnText()).toBe("");
  });

  it("插件目录缺失 → warn + missing-entry 跳过，不阻断同 agent 其余条目", async () => {
    await writePlugin("present", recordPlugin("present"));
    await writeAgentDir("agent-a", "plugins:\n  ghost: {}\n  present: {}\n");

    const ctx = await mount(["agent-a"]);

    expect(ctx.external.perAgent).toEqual([
      { agentId: "agent-a", name: "ghost", status: "missing-entry" },
      { agentId: "agent-a", name: "present", status: "loaded" },
    ]);
    expect(warnText()).toContain("ghost");
  });

  it("同一插件被全局清单与 agent 清单同时启用：各自独立挂载、config 不同", async () => {
    await writePlugin("dual", callsPlugin("dual"));
    await fs.writeFile(path.join(tempDir, "plugins.json"), JSON.stringify({ plugins: { dual: { config: { scope: "global" } } } }));
    await writeAgentDir("agent-a", "plugins:\n  dual:\n    config:\n      scope: agent\n");

    const ctx = await mount(["agent-a"]);

    expect(ctx.external.loaded).toEqual(["dual"]); // 全局记 E1 面
    expect(ctx.external.perAgent).toEqual([{ agentId: "agent-a", name: "dual", status: "loaded" }]);
    expect(g.__ext?.calls).toEqual([{ scope: "global" }, { scope: "agent", agentId: "agent-a" }]);
  });
});

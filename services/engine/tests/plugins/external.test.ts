import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreDataDir } from "../helpers/env.js";
import { logger } from "../../src/logger.js";
import * as externalPlugin from "../../src/plugins/external/index.js";

// 迁移第二阶段 E1：external 插件（外部插件发现/加载骨架）测试。
// 临时目录当 DATA_DIR（CLOUDMIND_DATA_DIR 模式同 tests/plugins/config.test.ts），
// fixture 插件（index.mjs 纯 JS ESM）现场写盘；loader 只消费模块级 logger
// （inject=[]），直挂 root Context，不复用 agents 系挂载链。
// fixture 侧效果经 globalThis.__ext 通道断言——动态 import 的 fixture 与测试
// 同进程同 globalThis，比「经 config 穿 markerPath 写文件」更直接。

/** fixture 侧效果记录通道（beforeEach 重置；fixture 按自身 name 记账） */
type FixtureState = Record<string, { config?: unknown; ready?: boolean }>;
const g = globalThis as { __ext?: FixtureState };

describe("plugins/external（E1：外部插件发现/加载骨架）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-plugin-test-"));
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

  /** 写全局清单 DATA_DIR/plugins.json */
  async function writeManifest(manifest: unknown): Promise<void> {
    await fs.writeFile(path.join(tempDir, "plugins.json"), JSON.stringify(manifest));
  }

  /** 直挂 root Context 并等骨架加载落定（await 至 loader ACTIVE） */
  async function mount(): Promise<Context> {
    const ctx = new Context();
    await ctx.plugin(externalPlugin);
    return ctx;
  }

  /**
   * 记录型 fixture：apply 把收到的 config 写进通道
   * （apply 被调 + config 透传的证据；extra 供追加 inject 等导出）
   */
  const recordPlugin = (name: string, extra = ""): string => `
export const name = ${JSON.stringify(name)};
${extra}
export function apply(ctx, config) {
  globalThis.__ext[${JSON.stringify(name)}] = { config };
}
`;

  it("清单登记的有效插件：挂载成功，apply 被调且 config 透传", async () => {
    await writePlugin("alpha", recordPlugin("alpha"));
    await writeManifest({ plugins: { alpha: { config: { greeting: "你好" } } } });

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual(["alpha"]);
    expect(ctx.external.skipped).toEqual([]);
    expect(g.__ext?.alpha?.config).toEqual({ greeting: "你好" });
  });

  it("清单条目缺省字段：enabled 缺省 true、config 缺省 {}", async () => {
    await writePlugin("beta", recordPlugin("beta"));
    await writeManifest({ plugins: { beta: {} } }); // enabled/config 全缺省

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual(["beta"]);
    expect(g.__ext?.beta?.config).toEqual({});
  });

  it("外部插件可监听 engine/ready（serial 发射后收到）", async () => {
    await writePlugin(
      "ready-listener",
      `
export const name = "ready-listener";
export function apply(ctx) {
  globalThis.__ext["ready-listener"] = { ready: false };
  ctx.on("engine/ready", () => {
    globalThis.__ext["ready-listener"].ready = true;
  });
}
`,
    );
    await writeManifest({ plugins: { "ready-listener": {} } });

    const ctx = await mount();
    await ctx.serial("engine/ready");

    expect(ctx.external.loaded).toEqual(["ready-listener"]);
    expect(g.__ext?.["ready-listener"]?.ready).toBe(true);
  });

  it("无效形态：清单登记但无 index.mjs → 跳过 + warn，不阻断其他插件", async () => {
    await writePlugin("good", recordPlugin("good"));
    await writeManifest({ plugins: { ghost: {}, good: {} } }); // ghost 无目录

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual(["good"]); // 单个失败不阻断其余
    expect(ctx.external.skipped).toEqual([{ name: "ghost", reason: "missing-entry" }]);
    expect(warnText()).toContain("ghost");
  });

  it("无效形态：缺 apply → 跳过 + warn", async () => {
    await writePlugin("no-apply", `export const name = "no-apply";\n`);
    await writeManifest({ plugins: { "no-apply": {} } });

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual([]);
    expect(ctx.external.skipped).toEqual([{ name: "no-apply", reason: "no-apply" }]);
    expect(warnText()).toContain("no-apply");
  });

  it("无效形态：name 导出非字符串 → 跳过 + warn", async () => {
    await writePlugin(
      "bad-name",
      `
export const name = 42;
export function apply() {}
`,
    );
    await writeManifest({ plugins: { "bad-name": {} } });

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual([]);
    expect(ctx.external.skipped).toEqual([{ name: "bad-name", reason: "invalid-name" }]);
    expect(warnText()).toContain("bad-name");
  });

  it("无效形态：name 与目录名不符 → 跳过 + warn", async () => {
    await writePlugin(
      "beta",
      `
export const name = "gamma";
export function apply() {}
`,
    );
    await writeManifest({ plugins: { beta: {} } });

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual([]);
    expect(ctx.external.skipped).toEqual([{ name: "beta", reason: "name-mismatch" }]);
    expect(warnText()).toContain("beta");
  });

  it("plugins.json 缺失 → 零加载，不 warn（静默空清单）", async () => {
    // 无清单、无 plugins 目录
    const ctx = await mount();

    expect(ctx.external.loaded).toEqual([]);
    expect(ctx.external.skipped).toEqual([]);
    expect(warnText()).toBe("");
  });

  it("plugins.json 损坏（非法 JSON）→ 零加载 + warn", async () => {
    await fs.writeFile(path.join(tempDir, "plugins.json"), "{ not json");

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual([]);
    expect(ctx.external.skipped).toEqual([]);
    expect(warnText()).toContain("plugins.json");
  });

  it("目录存在但清单未登记 → 不挂载 + warn 提示", async () => {
    await writePlugin("orphan", recordPlugin("orphan"));
    await writeManifest({ plugins: {} }); // 空清单

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual([]);
    expect(g.__ext?.orphan).toBeUndefined(); // apply 未执行
    expect(warnText()).toContain("orphan");
  });

  it("inject 声明不存在的服务 → fiber 停 PENDING，统一 warn 列未激活名", async () => {
    await writePlugin("pending-one", recordPlugin("pending-one", `export const inject = ["no-such-service"];`));
    await writeManifest({ plugins: { "pending-one": {} } });

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual([]);
    expect(ctx.external.skipped).toEqual([{ name: "pending-one", reason: "pending" }]);
    expect(g.__ext?.["pending-one"]).toBeUndefined(); // PENDING：apply 未执行
    expect(warnText()).toContain("未激活");
    expect(warnText()).toContain("pending-one");
  });

  it("enabled:false → 不挂载（记 disabled），其余插件不受影响", async () => {
    await writePlugin("off", recordPlugin("off"));
    await writePlugin("on", recordPlugin("on"));
    await writeManifest({ plugins: { off: { enabled: false }, on: {} } });

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual(["on"]);
    expect(ctx.external.skipped).toEqual([{ name: "off", reason: "disabled" }]);
    expect(g.__ext?.off).toBeUndefined(); // apply 未执行
  });

  it("apply 抛错 → warn + 跳过，不阻断其他插件（fail-closed）", async () => {
    await writePlugin(
      "boom",
      `
export const name = "boom";
export function apply() {
  throw new Error("boom");
}
`,
    );
    await writePlugin("good", recordPlugin("good"));
    await writeManifest({ plugins: { boom: {}, good: {} } });

    const ctx = await mount();

    expect(ctx.external.loaded).toEqual(["good"]);
    expect(ctx.external.skipped).toEqual([{ name: "boom", reason: "apply-failed" }]);
    expect(warnText()).toContain("boom");
  });
});

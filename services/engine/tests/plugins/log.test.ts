import { describe, it, expect, afterEach, vi } from "vitest";
import { Context } from "cordis";
import { logger } from "../../src/logger.js";
import * as logPlugin from "../../src/plugins/log/index.js";

// P1 log 插件挂载测试：只断言「ctx.log 可用且为进程单例本体」，
// 不向 logger 实际写日志（避免污染测试输出与 /logs 环形缓冲）。
describe("plugins/log（P1）", () => {
  it("挂载后 ctx.log 可用，且为进程单例 logger 本体", async () => {
    const ctx = new Context();
    await ctx.plugin(logPlugin);
    expect(ctx.log).toBe(logger);
    expect(typeof ctx.log.info).toBe("function");
  });
});

// M51：ZOME_LOG_LEVEL 白名单校验。logger 在模块 import 时按环境变量构造，
// 用 resetModules + 动态 import 拿不同环境变量下的新实例。
describe("plugins/log ZOME_LOG_LEVEL 校验（M51）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** 拦截 stdout 捕获构造期的回落 warn（不污染测试输出），返回捕获行 */
  function captureStdout(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write);
    return written;
  }

  it("非法 level 回落 info 并 warn 一次（不抛错致启动失败）", async () => {
    vi.stubEnv("ZOME_LOG_LEVEL", "verbose-typo");
    vi.resetModules();
    const written = captureStdout();

    const mod = await import("../../src/plugins/log/logger.js");

    expect(mod.logger.level).toBe("info");
    // pino 输出为 JSON 行（内层引号被转义），分开断言两个关键片段
    expect(written.some((l) => l.includes("verbose-typo") && l.includes("已回落 info"))).toBe(true);
  });

  it("合法 level 原样生效（debug），无回落 warn", async () => {
    vi.stubEnv("ZOME_LOG_LEVEL", "debug");
    vi.resetModules();
    const written = captureStdout();

    const mod = await import("../../src/plugins/log/logger.js");

    expect(mod.logger.level).toBe("debug");
    expect(written.some((l) => l.includes("已回落"))).toBe(false);
  });

  it("未设置 ZOME_LOG_LEVEL 默认 info", async () => {
    vi.stubEnv("ZOME_LOG_LEVEL", "");
    delete process.env.ZOME_LOG_LEVEL; // stubEnv 不支持取消设置，手动删除（afterEach 统一恢复）
    vi.resetModules();

    const mod = await import("../../src/plugins/log/logger.js");

    expect(mod.logger.level).toBe("info");
  });
});

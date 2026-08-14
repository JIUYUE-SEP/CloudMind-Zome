import { describe, it, expect } from "vitest";
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

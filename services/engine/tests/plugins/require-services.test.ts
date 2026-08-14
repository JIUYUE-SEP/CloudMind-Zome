import { describe, it, expect } from "vitest";
import { Context } from "cordis";
import * as logPlugin from "../../src/plugins/log/index.js";
import * as configPlugin from "../../src/plugins/config/index.js";
import { assertServices } from "../../src/plugins/require-services.js";

// P3 任务 0：挂载后 fail-fast 断言——cordis 对 PENDING 纤维的 await plugin()
// 立即落定（promise 兑现≠激活），缺失的服务会静默 undefined 到首用才炸；
// assertServices 在挂载完成时把缺失变成启动即炸。
describe("plugins/require-services（P3 任务 0）", () => {
  it("全部就位时不抛", async () => {
    const ctx = new Context();
    await ctx.plugin(logPlugin);
    await ctx.plugin(configPlugin);
    expect(() => assertServices(ctx, ["log", "config"])).not.toThrow();
  });

  it("缺失即抛，错误信息带缺失插件名", async () => {
    const ctx = new Context();
    await ctx.plugin(logPlugin);
    expect(() => assertServices(ctx, ["log", "config"])).toThrow(/config/);
  });

  it("全缺时报第一个缺失项", () => {
    const ctx = new Context();
    expect(() => assertServices(ctx, ["log", "config"])).toThrow(/log/);
  });
});

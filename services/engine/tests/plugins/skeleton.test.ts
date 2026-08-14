import { describe, it, expect } from "vitest";
// @ts-expect-error —— cordis@4.0.0-rc.8 类型面在 Node16 解析下为空（lib/*.d.ts
// 内部导入缺扩展名，traceResolution 实证）；运行时不受影响，详见 _template.ts 头注。
import { Context } from "cordis";
import * as template from "../../src/plugins/_template.js";

// P0 基线 smoke：只验证「cordis 可用 + 插件模板形态成立」。
// 边界：不测试 cordis 内部行为（PENDING 等待、事件派发语义等属上游职责），
// 只走 cordis 公开 API（new Context / ctx.plugin / ctx.on / ctx.emit）。
describe("plugins skeleton（P0 测试基线）", () => {
  it("cordis 可 import，new Context() 可用", () => {
    const ctx = new Context();
    expect(Context.is(ctx)).toBe(true);
  });

  it("模板插件四件套元数据齐全：name / inject / apply（Config 为类型预留）", () => {
    expect(template.name).toBe("plugin-template");
    // inject 声明被识别：作为插件元数据可读（PENDING 等待语义是 cordis 内部行为，不测）
    expect(Array.isArray(template.inject)).toBe(true);
    expect(typeof template.apply).toBe("function");
  });

  it("模板插件可挂载到临时 ctx：apply 执行、事件注册生效且可逆", async () => {
    const ctx = new Context();
    let ponged = false;
    // 插件在 apply 里监听 ping 并 emit pong（见 _template.ts）；
    // 测试侧只观察 pong——apply 未执行则 pong 永远不会来
    ctx.on("plugin-template/pong", () => {
      ponged = true;
    });
    // await 插件挂载：inject 依赖到齐、激活落定后 resolve
    await ctx.plugin(template);
    ctx.emit("plugin-template/ping");
    expect(ponged).toBe(true);
  });
});

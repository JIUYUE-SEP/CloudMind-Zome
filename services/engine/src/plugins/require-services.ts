import type { Context } from "cordis";

/**
 * 挂载后 fail-fast 断言（P3 任务 0）：cordis 对 PENDING 纤维的
 * `await ctx.plugin()` 立即落定（promise 兑现 ≠ 激活，P2 复审实证）——
 * 若有人调序/禁用上游插件，服务会静默 undefined 到首用才 TypeError。
 * 挂载完成后显式断言就位，缺失即启动即炸，不带到运行时。
 *
 * 维护责任：每期插件化新服务后，把该服务名加进 bootstrap 的调用列表。
 */
export function assertServices(root: Context, names: (keyof Context)[]): void {
  for (const name of names) {
    if (!root[name]) {
      throw new Error(
        `[bootstrap] 插件服务未就位：${String(name)}（检查挂载顺序 / inject 依赖 / 插件是否被禁用）`,
      );
    }
  }
}

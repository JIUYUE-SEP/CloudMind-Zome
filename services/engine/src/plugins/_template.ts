// @ts-expect-error —— cordis@4.0.0-rc.8 类型面在 Node16 解析下为空：其 lib/*.d.ts
// 内部相对导入无扩展名（Node16 ESM 模式不做扩展名搜索，traceResolution 实证
// './context' not resolved），entry 的 export * 全部落空。运行时不受影响
// （lib 为单文件 bundle），本抑制仅为 P0 期过渡；恢复途径：pnpm patch 补扩展名
// 或上游修复（属 P1 前置，见 P0 交付报告），恢复后删除本注释即回全类型。
import type { Context } from "cordis";

/**
 * CMZ 内部插件模板（P0 期）：四件套范本。
 *
 * 形态参照 dsh 的 time-context 插件
 * （参考仓库 packages/context/time-context/src/index.ts）：
 * ESM 模块导出即插件——name / inject / Config / apply 四件套，
 * 整个模块命名空间作为 Plugin.Object 交给 ctx.plugin() 挂载。
 *
 * CMZ 约定：
 * - 插件 = 服务上架 + 事件注册。服务经 ctx.provide/Service 子类上架，
 *   事件经 ctx.on/ctx.once 注册，其他插件经 inject 声明依赖后消费。
 * - 一切注册必须可逆：只使用随 fiber 卸载自动回收的注册方式
 *   （ctx.on / ctx.once / ctx.effect / Service 构造），禁止挂全局变量、
 *   禁止在插件外留不可摘除的监听器。
 * - 事件命名：`插件名/事件名`（见下方 Events 接口扩展），派发模式
 *   （emit/waterfall/serial/parallel）是事件公共契约的一部分，定义时
 *   以 JSDoc 注明（cordis 五种派发模式语义见迁移方案文档 A1 节）。
 */

/** 插件名：诊断与日志显示用，与目录名保持一致 */
export const name = "plugin-template";

/**
 * inject：声明激活前必须就位的服务。缺依赖时 fiber 停在 PENDING，
 * 依赖到齐才激活（替代 bootstrap.ts 的手工排序）。空数组 = 无依赖。
 * 本模板无依赖；真实插件按 B1 服务清单声明，如 ["config", "log"]。
 */
export const inject: string[] = [];

/**
 * Config：插件配置的类型面。运行期校验预留 standard-schema 接口
 * （cordis Plugin.Base.Config: StandardSchemaV1）——真实插件用 zod
 * （3.24+ 已实现 standard-schema）补同名运行期 schema，启动前校验、
 * 非法配置直接加载失败。P0 只立类型，不引校验器。
 */
export interface Config {
  /** 示例配置项：插件自身的开关/参数（真实插件按需定义，可删） */
  readonly example?: string;
}

/**
 * 本插件注册/消费的事件，经接口合并进 cordis Events 获得类型检查。
 * 这是 cordis 官方扩展点（lib/events.d.ts 的 Events 接口）。
 */
declare module "cordis" {
  interface Events {
    /** @mode emit —— 模板心跳：测试侧 emit，插件应答 pong */
    "plugin-template/ping": () => void;
    /** @mode emit —— 模板应答：apply 已执行、注册已生效的证据 */
    "plugin-template/pong": () => void;
  }
}

/**
 * apply：插件激活入口。config 为校验后的配置（P0 模板不消费）。
 * 函数体里只允许做可逆注册；返回的 disposer 由 cordis fiber 持有，
 * 插件卸载时自动逆序执行，无需手写 teardown。
 */
export function apply(ctx: Context, config?: Config): void {
  void config; // P0 模板不消费配置；真实插件在此读取校验后配置
  ctx.on("plugin-template/ping", () => {
    ctx.emit("plugin-template/pong");
  });
}

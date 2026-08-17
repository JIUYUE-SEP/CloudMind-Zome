import type { Context } from "cordis";
import { HandoffManager } from "../../handoff/manager.js";
import { HandoffStateStore } from "../../handoff/state.js";
import { HandoffLoopRegistry } from "../../handoff/registry.js";
import { HandoffConnectionBridge, type HandoffConnectionDeps } from "./connection-bridge.js";

/**
 * handoff 插件（P7b）：换班移交控制面三件套 + WS 续跑循环连接桥收编。
 *
 * - HandoffStateStore/HandoffManager/HandoffLoopRegistry 自 bootstrap.ts 迁入
 *   （原 bootstrap 构造的同一批实例，只换实例来源，行为零变化）；
 * - 启动对账 manager.load() 收进本 apply：async apply 由 fiber 激活等待，
 *   await ctx.plugin(handoffPlugin) 保持原 bootstrap「listen 前对账」时序
 *   （P3 tools 插件 connectAll 同款先例；bootstrap 不再调 load）；
 * - WS 私聊的续跑循环职责（建 loop / 注册 / book 拦截 / 断连收尾）收进连接桥
 *   HandoffConnectionBridge，handler 经 attachConnection 取桥；连接特有物
 *   （发帧 / 历史加载 / worker 解析）全经回调注入，插件不 import api/*；
 * - inject 为空：三件套自给自足（状态文件路径经 config/paths 模块函数），
 *   不消费任何 ctx 服务。
 */
export const name = "handoff";

/** 无 ctx 服务依赖（见头注） */
export const inject: string[] = [];

/** ctx.handoff 上架面 */
export interface HandoffFace {
  /** 换班移交控制面（handoff-state.json；ApiContext handoffManager 换源用） */
  manager: HandoffManager;
  /** 活跃续跑循环注册表（ApiContext handoffLoops 换源用；仲裁面唯一桥） */
  loops: HandoffLoopRegistry;
  /** 私聊连接桥工厂（WS handler 每连接调一次：建 loop + 注册进 registry） */
  attachConnection(deps: HandoffConnectionDeps): HandoffConnectionBridge;
}

declare module "cordis" {
  interface Context {
    /** 换班移交服务面（见 HandoffFace） */
    handoff: HandoffFace;
  }
}

export async function apply(ctx: Context): Promise<void> {
  const manager = new HandoffManager({ store: new HandoffStateStore() });
  const loops = new HandoffLoopRegistry();
  // 换班控制面启动对账（见头注）：活跃续跑条目标 lost（重启后不自动续跑，
  // 交接书仍在历史）——apply 完成即对账完成，须 listen 前完成
  await manager.load();
  ctx.provide("handoff", {
    manager,
    loops,
    attachConnection: (deps) => new HandoffConnectionBridge(deps, { manager, loops }),
  } satisfies HandoffFace);
}

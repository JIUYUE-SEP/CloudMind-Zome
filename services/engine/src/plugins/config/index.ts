import type { Context } from "cordis";
import { ConfigRepository } from "../../config/repository.js";

/**
 * config 插件（P1）：ConfigRepository 上架 ctx.config。
 *
 * 粒度取舍：只上架有状态实例（ConfigRepository，bootstrap.ts 原 :87 的构造点）。
 * paths / crypto / agent-tools 是无状态模块函数、auth-token 是模块级缓存
 * （getAuthToken，bootstrap.ts:602 listen 前就绪语义不变），均无实例可上架，
 * 直 import 面保留。
 */
export const name = "config";

/** 无依赖：ConfigRepository 自给自足（见下），不等任何服务 */
export const inject: string[] = [];

declare module "cordis" {
  interface Context {
    /** 全局配置仓库（config.json 读写/迁移/加解密面） */
    config: ConfigRepository;
  }
}

export function apply(ctx: Context): void {
  // 批准的过渡形态（P1 任务书）：ConfigRepository 对 memory/document-store 的
  // 值级出边（auth-token.ts:4、crypto.ts:4、repository.ts:4）本期保留直 import——
  // document-store 是 memory 基座，P4 才插件化，本期不绕道提前收它。
  ctx.provide("config", new ConfigRepository());
}

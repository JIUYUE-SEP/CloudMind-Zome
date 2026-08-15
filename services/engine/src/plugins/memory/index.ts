import type { Context } from "cordis";
import { AgentRepository } from "../../memory/repositories/agent.js";
import { MessageRepository } from "../../memory/repositories/message.js";
import { MemoryRepository } from "../../memory/repositories/memory.js";
import { ActionRepository } from "../../memory/repositories/action.js";
import { LLMCallRepository } from "../../memory/repositories/llm-call.js";
import { RecallService } from "../../memory/recall.js";
import {
  reconcileHotStorage,
  reconcileOrphanedTopic,
  reconcilePendingSegments,
} from "../../memory/reconcile.js";

/**
 * memory 插件（P4）：存储基座面上架 ctx.memory。
 *
 * - repository 工厂面：getXxxRepository 均为 per-agent/ per-call 现造
 *   （与原 bootstrap ApiContext 工厂同一语义，不缓存）；
 * - agentRepository 是进程单例（agents 服务的配置半边——P6 才与
 *   WorkerRegistry 合体为 agents 插件，本期只换实例来源）；
 * - document-store 已迁入本目录作内部实现（方案 B1 定案：不作独立服务露面），
 *   各 repository 与其他模块对它保持库级直 import（非 ctx 服务）；
 * - per-agent 的 MemoryIndexer（worker 创建链按 embedder 现造）不上架。
 */
export const name = "memory";

/** 无 ctx 服务依赖（repositories/recall 自给自足，路径经 config/paths 模块函数） */
export const inject: string[] = [];

/** ctx.memory 上架面 */
export interface MemoryFace {
  /** agent 配置仓库（单例；P6 合体进 agents 插件，见头注） */
  agentRepository: AgentRepository;
  getMessageRepository(agentId: string): MessageRepository;
  getMemoryRepository(agentId: string): MemoryRepository;
  getActionRepository(agentId: string): ActionRepository;
  getLLMCallRepository(agentId: string): LLMCallRepository;
  /** 回忆服务（recall 工具）：只读本 agent 自己的压缩档目录与归档原文 */
  recall: RecallService;
  /** 启动对账三入口（reconcile.ts 模块函数直通，deps 由调用方装配） */
  reconcileHotStorage: typeof reconcileHotStorage;
  reconcileOrphanedTopic: typeof reconcileOrphanedTopic;
  reconcilePendingSegments: typeof reconcilePendingSegments;
}

declare module "cordis" {
  interface Context {
    /** 存储基座面（见 MemoryFace） */
    memory: MemoryFace;
  }
}

export function apply(ctx: Context): void {
  const getMessageRepository = (agentId: string) => new MessageRepository(agentId);
  ctx.provide("memory", {
    agentRepository: new AgentRepository(),
    getMessageRepository,
    getMemoryRepository: (agentId) => new MemoryRepository(agentId),
    getActionRepository: (agentId) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId) => new LLMCallRepository(agentId),
    // 回忆服务（recall 工具）：只读本 agent 自己的压缩档目录与归档原文
    recall: new RecallService({ getMessageRepository }),
    reconcileHotStorage,
    reconcileOrphanedTopic,
    reconcilePendingSegments,
  } satisfies MemoryFace);
}

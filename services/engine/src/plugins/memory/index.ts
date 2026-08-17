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
import { registerStartupReconcile } from "./startup-reconcile.js";

/**
 * memory 插件（P4）：存储基座面上架 ctx.memory。
 *
 * - repository 工厂面：getXxxRepository 均为 per-agent/ per-call 现造
 *   （与原 bootstrap ApiContext 工厂同一语义，不缓存）；
 * - agentRepository 是进程单例（agents 服务的配置半边——P6 才与
 *   WorkerRegistry 合体为 agents 插件，本期只换实例来源）；
 * - document-store 已迁入本目录作内部实现（方案 B1 定案：不作独立服务露面），
 *   各 repository 与其他模块对它保持库级直 import（非 ctx 服务）；
 * - per-agent 的 MemoryIndexer（worker 创建链按 embedder 现造）不上架；
 * - P9：启动对账迁入（./startup-reconcile.ts），经 engine/ready 事件驱动
 *   （serial，注册序 = 激活序——本插件先于 scheduler 激活，对账先于轮询，
 *   顺序依赖见事件 JSDoc 与 plugins/scheduler 头注）；inject 随之追加
 *   llm/mind（对账的 provider 工厂与 ctx.mind 面）。不得 inject agents——
 *   agents inject memory，成环死等。
 */
export const name = "memory";

/** repositories/recall 自给自足；llm（对账 provider 工厂）/mind（对账 deps）为 P9 对账依赖（见头注） */
export const inject = ["llm", "mind"];

/**
 * memory/archived 事件载荷（P8b）：话题压缩归档成功（先归档后移除热存储
 * 完成）后发；只带 id，read-back 由消费者自行做（invariants A4-3）。
 */
export interface MemoryArchivedEvent {
  agentId: string;
  ids: string[];
}

/**
 * 插件 config（P8b 过渡形态，skills/agents 先例）：memory/archived 事件的
 * ctx 通道经 config 回调进场——bootstrap 以闭包接事件总线（serial 派发）；
 * 缺省不提供则归档路径零事件、零行为变化。
 */
export interface Config {
  onTopicArchived?: (agentId: string, ids: string[]) => void | Promise<void>;
}

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
  /** P8b：memory/archived 事件通道（来自插件 config 回调；缺省 undefined 不发事件） */
  onTopicArchived?: (agentId: string, ids: string[]) => void | Promise<void>;
}

declare module "cordis" {
  interface Context {
    /** 存储基座面（见 MemoryFace） */
    memory: MemoryFace;
  }
  interface Events {
    /**
     * @mode serial —— 话题压缩归档成功（P8b；archiveAndRemove 完成后由压缩
     * 任务发）。v1 事件地图同族事件记 emit；落地 serial 的理由与 turn/step
     * 相同（见 plugins/agents 的 Events 声明注）：cordis emit 不等待异步
     * 监听，invariants 的归档 read-back 是异步的，enforce 抛错要传回发射点
     * （压缩任务 → 队列告警 + pending 段保留）必须按序等待。
     */
    "memory/archived": (payload: MemoryArchivedEvent) => void | Promise<void>;
    /**
     * @mode serial —— engine 启动装配就绪（P9）：bootstrap 在 assertServices
     * 之后、http listen 之前 `await root.serial("engine/ready")` 发射一次。
     * serial 按注册序等待异步监听——监听注册序 = 插件激活序（memory 先于
     * scheduler），保证启动对账完成才起 scheduler 轮询（原 bootstrap
     * 「对账 → scheduler.start() → createServer」先后序的事件化表达；
     * 顺序依赖同见 plugins/scheduler 头注）。
     */
    "engine/ready": () => void | Promise<void>;
  }
}

export function apply(ctx: Context, config?: Config): void {
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
    // P8b：事件通道透传（缺省不上架该字段，agents 装配层按 undefined 处理）
    ...(config?.onTopicArchived ? { onTopicArchived: config.onTopicArchived } : {}),
  } satisfies MemoryFace);
  // P9：启动对账监听 engine/ready（见 ./startup-reconcile.ts 头注的顺序依赖）
  registerStartupReconcile(ctx);
}

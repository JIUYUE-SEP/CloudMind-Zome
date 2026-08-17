import type { Context } from "cordis";
import { IntermindService } from "../../intermind/service.js";
import { MessageRepository } from "../../memory/repositories/message.js";

/**
 * intermind 插件（P7d）：人形间私信服务收编上架 ctx.intermind。
 *
 * - IntermindService 自 bootstrap.ts 迁入（原 bootstrap 构造的同一批依赖，
 *   只换实例来源，行为零变化）：写信/唤醒/会话检索（一期）。
 * - 依赖换源：getAgentConfig → ctx.agents.agentRepository.get（agents 面合体
 *   单例）、getAgentWorker → ctx.agents.getOrCreateWorker；getMessageRepository
 *   库级直 new MessageRepository(agentId)（P4 先例，口径不变，不进插件面）。
 * - inject ["agents"]：agents 面就绪才激活。agents 插件不反向 inject——
 *   其 worker services 字典里的 intermindService 经 config 回调闭包延迟
 *   求值取 root.intermind（回调在首个 worker 创建时才被调用，挂载顺序安全）。
 */
export const name = "intermind";

/** getAgentConfig / getAgentWorker 来自 agents 面（见头注） */
export const inject = ["agents"];

declare module "cordis" {
  interface Context {
    /** 人形间私信服务（ApiContext.intermindService 与 agents config 回调换源用） */
    intermind: IntermindService;
  }
}

export function apply(ctx: Context): void {
  // Intermind 人形间私信（一期）：写信/唤醒/会话检索
  ctx.provide(
    "intermind",
    new IntermindService({
      getAgentConfig: (agentId) => ctx.agents.agentRepository.get(agentId),
      getMessageRepository: (agentId) => new MessageRepository(agentId),
      getAgentWorker: (agentId) => ctx.agents.getOrCreateWorker(agentId),
    }),
  );
}

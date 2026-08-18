import type { Context } from "cordis";
import { logger } from "../../logger.js";
import { MessageRepository } from "../../memory/repositories/message.js";
import { LLMCallRepository } from "../../memory/repositories/llm-call.js";
import { loadTopicState } from "../../memory/topic/state.js";
import { withLLMCallRecording } from "../llm/record-calls.js";

/**
 * 启动对账（Phase 2 M3，P9 自 bootstrap.ts 逐字迁入，字段来源 root.* → ctx.*）。
 *
 * 经 engine/ready 事件驱动（@mode serial，声明见 ./index.ts 的 Events 合并）：
 * bootstrap 在 assertServices 后、http listen 前 `await root.serial("engine/ready")`
 * 发射一次；serial 按注册序等待异步监听——**注册序 = 插件激活序，本插件先于
 * scheduler 激活**，保证对账完成才起轮询（原 bootstrap「对账 → scheduler.start()
 * → createServer」先后序不变；顺序依赖同样写在 plugins/scheduler 头注）。
 */
export function registerStartupReconcile(ctx: Context): void {
  ctx.on("engine/ready", async () => {
    // 启动对账（Phase 2 M3）：补归档"已有压缩档但仍留在热存储"的孤儿消息。
    // 在 scheduler/worker 产生新流量前完成；单 agent 失败只记 warn，不阻断启动。
    // ZOME_STARTUP_RECONCILE=false 可关闭（手动管理热存储的场景）。
    if (process.env.ZOME_STARTUP_RECONCILE !== "false") {
      const agents = await ctx.memory.agentRepository.list();
      for (const agent of agents) {
        try {
          const repo = new MessageRepository(agent.id);
          const count = await ctx.memory.reconcileHotStorage(agent.id, repo);
          if (count > 0) {
            logger.info(`[reconcile] agent=${agent.id} 补归档孤儿消息 ${count} 条`);
          }
          // P1-2：重启孤儿（退出时仍在未关闭话题里的消息）。先查 topic-state.json
          // （廉价文件读），有孤儿才构造 LLM provider 补压缩/归档
          const orphanState = await loadTopicState(agent.id);
          const hasOpen = orphanState?.open && orphanState.open.messageIds.length > 0;
          const hasPending = (orphanState?.pending ?? []).length > 0;
          if (hasOpen || hasPending) {
            const providerConfig = await ctx.llm.findProviderConfig(agent.providerId);
            const deps = {
              agentId: agent.id,
              // P4 review Minor-2：reconcile 孤儿压缩同样经 record-calls 落档，与主链路一致
              provider: withLLMCallRecording(
                await ctx.llm.createProvider(agent),
                new LLMCallRepository(agent.id),
                agent.id,
                {
                  providerId: providerConfig?.id,
                  providerName: providerConfig?.displayName ?? providerConfig?.id,
                },
              ),
              model: agent.compressionModel || agent.modelId || agent.model || "gpt-4o",
              boundaryModel:
                agent.topicBoundaryModel ||
                agent.compressionModel ||
                agent.modelId ||
                agent.model ||
                "gpt-4o",
              messageRepository: repo,
              // P4：compression-task 已 inject 化，mind 能力从 ctx.mind 取下喂入
              mind: ctx.mind,
            };
            // M-b：先补"已关闭已入队未压缩"的 pending 段（强杀路径缺口）
            if (hasPending) {
              const pendingCount = await ctx.memory.reconcilePendingSegments(agent.id, repo, deps);
              if (pendingCount > 0) {
                logger.info(`[reconcile] agent=${agent.id} 补处理 pending 压缩段消息 ${pendingCount} 条`);
              }
            }
            if (hasOpen) {
              const orphanCount = await ctx.memory.reconcileOrphanedTopic(agent.id, repo, deps);
              if (orphanCount > 0) {
                logger.info(`[reconcile] agent=${agent.id} 处理重启孤儿消息 ${orphanCount} 条`);
              }
            }
          }
        } catch (err) {
          logger.warn({ err: err }, `[reconcile] agent=${agent.id} 对账失败，跳过（不阻断启动）`);
        }
      }
    }
  });
}

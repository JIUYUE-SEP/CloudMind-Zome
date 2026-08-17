import type { Context } from "cordis";
import { logger } from "../../logger.js";

/**
 * invariants 插件（P8b）：灵魂断言——迁移方案决策 2 的落地。
 *
 * 灵魂不做特权代码：A4 表的五条保证此前全部靠结构（链路上没有违例的口子），
 * 本插件把其中四条升级为**运行时断言**（A4-4 傀儡无 SOUL/无记忆是路径性
 * 设计，傀儡路径不接事件缝，不在断言范围）：
 *
 * - A4-1 同一 agentId 意识串行：监听 turn/step 与 turn/end 跟踪在途回合；
 *   载荷无回合 id（事件契约），可判定的违例 = 同 agent 两个不同 sessionId
 *   同时在途（多步回合与同会话串行回合不误伤，已知限制见头注末）。
 * - A4-2 模型可见即可从存储重建：① llm/request（prepend 首棒，dsh
 *   invariant.ts 同款）断言 agentId 非空且 agent 存在、messages 非空、
 *   首条 role=system（L1 人格前缀在位）；② turn/step 对 messageIds 做
 *   read-back——模型产出必须已落盘；③ turn/end 对非瞬态回合的输入消息
 *   逐条查证（热存储 ∨ 归档）——"先落盘后入队"必须成立；瞬态回合
 *   （ephemeral，蓝图）设计不落盘，豁免。
 * - A4-3 话题压缩先归档后移除热存储：memory/archived 时热存储必须读不到、
 *   归档必须全在。
 * - A4-5 审批 fail-closed：无审批通道却放行 requiresApproval 工具 = 越权。
 *
 * 模式（Config.mode）：
 * - enforce（缺省）：断言失败抛 InvariantError。emit/serial 派发会把错误
 *   传回发射点——视同该回合（或压缩任务）失败，与既有失败路径一致：
 *   turn/step 抛错经 onStepAppended 中止本轮（P1-6 落盘失败同路径）；
 *   turn/end 抛错兑现为 job onDone 错误；tool/approval 抛错经单 call 隔离
 *   转为该工具的错误结果（fail-closed 不被击穿）；memory/archived 抛错按
 *   压缩任务失败由队列告警、pending 段保留待对账。
 * - observe：logger.error 记档不抛，行为与无断言完全一致。
 *
 * 回退路径（P8）：摘除本插件即回结构性保证——事件缝全链路可选，
 * 无监听时 serial/waterfall 空转，worker/压缩任务零行为变化。
 *
 * A4-1 已知限制：turn/step 载荷（事件契约）不含回合 id，同会话的新回合
 * 与同一回合的后续 step 不可区分——只有跨 session 并行会被判违例；
 * 同会话并行（worker 注册表被击穿的最隐蔽形态）不在本断言视野内。
 */
export const name = "invariants";

/** read-back 用 message repository（ctx.memory 面），agent 查证用 agentRepository（ctx.agents 面） */
export const inject = ["agents", "memory"];

/** 插件配置：缺省 enforce——断言是保险，不是装饰 */
export interface Config {
  /** enforce：断言失败抛 InvariantError；observe：只 logger.error 记档 */
  readonly mode?: "enforce" | "observe";
}

/**
 * 断言失败错误：带断言编号（A4-x，对应迁移方案 A4 表）与上下文摘要。
 * 摘要不放消息正文等敏感内容（只放 id/计数/角色等元信息）。
 */
export class InvariantError extends Error {
  constructor(
    readonly invariant: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(`[${invariant}] ${message}`);
    this.name = "InvariantError";
  }
}

/** ctx.invariants 上架面（诊断/测试可读当前模式；fail-fast 断言的挂载证据） */
export interface InvariantsFace {
  readonly mode: "enforce" | "observe";
}

declare module "cordis" {
  interface Context {
    /** 灵魂断言面（见 InvariantsFace） */
    invariants: InvariantsFace;
  }
}

export function apply(ctx: Context, config?: Config): void {
  const mode = config?.mode ?? "enforce";

  /** 断言失败统一出口：enforce 抛错（不返回）；observe 记档后继续 */
  function fail(invariant: string, message: string, context: Record<string, unknown>): void {
    const err = new InvariantError(invariant, message, context);
    if (mode === "enforce") throw err;
    logger.error({ err, ...context }, `[invariants] ${invariant} 违例（observe 记档不抛）：${message}`);
  }

  // A4-1 在途回合跟踪：agentId → 未终止回合的 sessionId（turn/end 清除）
  const inFlight = new Map<string, { sessionId: string }>();

  // A4-2① llm/request（waterfall 首棒）：agentId 非空且 agent 存在、
  // messages 非空、首条 role=system（L1 在位）。prepend+global 与 dsh
  // invariant.ts 同款——断言先于一切改写/落档中间件
  ctx.on(
    "llm/request",
    async (payload, next) => {
      if (!payload.agentId) {
        fail("A4-2", "llm/request 载荷缺 agentId", { source: payload.source, model: payload.model });
      } else {
        // agentRepository.get 命中自带 LRU 缓存（纯内存读、watcher 失效），
        // 每次请求一查成本可忽略，不再叠加缓存层
        const agent = await ctx.agents.agentRepository.get(payload.agentId);
        if (!agent) {
          fail("A4-2", `llm/request 目标 agent 不存在：${payload.agentId}`, {
            agentId: payload.agentId,
            source: payload.source,
          });
        }
      }
      if (payload.messages.length === 0) {
        fail("A4-2", "llm/request messages 为空", { agentId: payload.agentId, source: payload.source });
      } else if (payload.messages[0]!.role !== "system") {
        fail("A4-2", `llm/request 首条消息 role=${payload.messages[0]!.role}（L1 人格前缀不在位）`, {
          agentId: payload.agentId,
          source: payload.source,
          firstRole: payload.messages[0]!.role,
        });
      }
      // observe 记档后照常放行（不否决）；enforce 已在 fail 抛出、走不到这里
      return next();
    },
    { prepend: true, global: true },
  );

  // turn/step：A4-1 串行跟踪 + A4-2② 模型产出落盘 read-back
  ctx.on("turn/step", async (payload) => {
    const prev = inFlight.get(payload.agentId);
    if (prev && prev.sessionId !== payload.sessionId) {
      fail(
        "A4-1",
        `同一 agent 意识并行：session ${prev.sessionId} 的回合未 turn/end，session ${payload.sessionId} 的回合已开始`,
        { agentId: payload.agentId, prevSessionId: prev.sessionId, sessionId: payload.sessionId },
      );
    }
    inFlight.set(payload.agentId, { sessionId: payload.sessionId });

    if (payload.messageIds.length === 0) return;
    const repo = ctx.memory.getMessageRepository(payload.agentId);
    const found = await repo.getByIds(payload.messageIds);
    const foundIds = new Set(found.map((m) => m.id));
    const missing = payload.messageIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      fail("A4-2", `模型产出未落盘：turn/step 有 ${missing.length}/${payload.messageIds.length} 条消息读不回`, {
        agentId: payload.agentId,
        sessionId: payload.sessionId,
        missingCount: missing.length,
        missingIds: missing,
      });
    }
  });

  // turn/end：A4-1 在途清除 + A4-2③ 输入消息"先落盘后入队"逐条查证
  ctx.on("turn/end", async (payload) => {
    inFlight.delete(payload.agentId);
    // 瞬态回合（蓝图）设计不落盘——豁免 read-back
    if (payload.ephemeral) return;
    if (payload.inputMessageIds.length === 0) return;
    const repo = ctx.memory.getMessageRepository(payload.agentId);
    const hot = await repo.getByIds(payload.inputMessageIds);
    const hotIds = new Set(hot.map((m) => m.id));
    const missingHot = payload.inputMessageIds.filter((id) => !hotIds.has(id));
    if (missingHot.length === 0) return;
    // 热存储缺的可能已随话题压缩归档——完整判据 = 热 ∨ 归档（消息可见即可重建）
    const archived = await repo.getArchivedByIds(missingHot);
    const archivedIds = new Set(archived.map((m) => m.id));
    const missing = missingHot.filter((id) => !archivedIds.has(id));
    if (missing.length > 0) {
      fail(
        "A4-2",
        `先落盘后入队被破坏：回合输入消息 ${missing.length}/${payload.inputMessageIds.length} 条在热存储与归档均读不回`,
        {
          agentId: payload.agentId,
          sessionId: payload.sessionId,
          jobId: payload.jobId,
          missingCount: missing.length,
          missingIds: missing,
        },
      );
    }
  });

  // memory/archived：A4-3 先归档后移除热存储——完成后热存储必须读不到、归档必须全在
  ctx.on("memory/archived", async (payload) => {
    if (payload.ids.length === 0) return;
    const repo = ctx.memory.getMessageRepository(payload.agentId);
    const hot = await repo.getByIds(payload.ids);
    if (hot.length > 0) {
      fail("A4-3", `归档后热存储仍残留 ${hot.length}/${payload.ids.length} 条（先归档后移除被破坏）`, {
        agentId: payload.agentId,
        remainingCount: hot.length,
        totalCount: payload.ids.length,
      });
    }
    const archived = await repo.getArchivedByIds(payload.ids);
    const archivedIds = new Set(archived.map((m) => m.id));
    const missing = payload.ids.filter((id) => !archivedIds.has(id));
    if (missing.length > 0) {
      fail("A4-3", `归档缺失 ${missing.length}/${payload.ids.length} 条（热存储已移除但归档读不回）`, {
        agentId: payload.agentId,
        missingCount: missing.length,
        totalCount: payload.ids.length,
      });
    }
  });

  // tool/approval：A4-5 审批 fail-closed——无通道放行 = 越权
  ctx.on("tool/approval", (payload) => {
    if (payload.requiresApproval && !payload.hasApprovalChannel && payload.approved === true) {
      fail("A4-5", `无审批通道放行危险工具（fail-closed 被突破）：${payload.toolName}`, {
        agentId: payload.agentId,
        toolName: payload.toolName,
      });
    }
  });

  ctx.provide("invariants", { mode } satisfies InvariantsFace);
}

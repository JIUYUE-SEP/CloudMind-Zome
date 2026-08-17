import type { Context } from "cordis";
import { logger } from "../../logger.js";

/**
 * perception 插件（P8a）：感知注入单口总线（迁移方案决策 3）。
 *
 * - `perception/inject` waterfall 是唯一感知注入点：一切「触发一轮感知回合」
 *   的系统通知（subagent 终态、intermind 私信唤醒，未来 scheduler 提醒等）
 *   一律经 ctx.perception.injectNotice 进场，消息带来源归属（source）。
 * - injectNotice 四步：① 白名单校验——source 不在 PERCEPTION_SOURCES：warn
 *   记档并丢弃（不入队，返回 false）；② ctx.waterfall("perception/inject",
 *   payload, 内建放行)——中间件可改写/追加文本（当前无其他监听，内建放行 =
 *   原样透传）；③ 解析 worker（ctx.agents.getOrCreateWorker），无 worker 时
 *   warn（沿用各生产者原「无可用 worker」文案语义）并跳过（返回 false）；
 *   ④ 入队感知回合（返回 true；落盘失败不影响返回，与 enqueueSystemNotice
 *   自身语义一致）。
 * - enqueueSystemNotice（core/agent-worker.ts）仍是「先落热存储再入队」的
 *   机制本体，perception 是其唯一生产调用方；直调绕过白名单（结构约定，
 *   P8b 断言兜底）。
 * - 白名单外插件只许经 waterfall 改写/追加、不许吞（waterfall 不调 next()
 *   即否决后续链含内建放行——决策 3 的结构兑现，P8b 断言兜底）。
 */
export const name = "perception";

/** worker 解析依赖 agents 面（getOrCreateWorker，见 plugins/agents） */
export const inject = ["agents"];

/**
 * 感知注入来源白名单：名单之外的 source warn 记档并丢弃（不入队）。
 * 未来 scheduler 提醒等新生产者在此扩充。
 */
export const PERCEPTION_SOURCES: readonly string[] = ["subagents", "intermind"];

/** 感知注入载荷：一条带来源归属的系统通知 */
export interface PerceptionInject {
  /** 来源插件（白名单校验依据，见 PERCEPTION_SOURCES） */
  source: string;
  /** 接收通知的 agent */
  targetAgentId: string;
  /** 通知文本（先落热存储再入队感知，机制见 enqueueSystemNotice） */
  text: string;
  /** 通知落盘/入队所用会话 id（subagents：notice_<taskId>；intermind：主会话 default） */
  sourceId: string;
  /** 透传选项（intermind 搭车标记：感知回合内回信不再唤醒） */
  opts?: { intermindRide?: boolean };
}

/** ctx.perception 上架面 */
export interface PerceptionFace {
  /**
   * 感知注入单口：白名单校验 → waterfall 改写链 → 解析 worker → 入队感知回合。
   * 返回是否真实入队：白名单丢弃 / 无可用 worker 跳过 = false，已入队 = true
   * （fire-and-forget 落盘失败不影响返回，与 enqueueSystemNotice 自身语义一致）。
   */
  injectNotice(payload: PerceptionInject): Promise<boolean>;
}

declare module "cordis" {
  interface Context {
    /** 感知注入单口（见 PerceptionFace） */
    perception: PerceptionFace;
  }
  interface Events {
    /**
     * @mode waterfall —— 感知注入改写链（决策 3）：中间件 (payload, next) 形态，
     * 改写/追加后 return next() 委托下游；不调 next() 即否决后续链与内建放行
     * （白名单外插件只许改写/追加、不许吞——结构约定，P8b 断言兜底）。
     */
    "perception/inject": (
      payload: PerceptionInject,
      next: () => PerceptionInject | Promise<PerceptionInject>,
    ) => PerceptionInject | Promise<PerceptionInject>;
  }
}

export function apply(ctx: Context): void {
  ctx.provide("perception", {
    async injectNotice(payload: PerceptionInject): Promise<boolean> {
      // ① 白名单校验：名单外 source 记档丢弃，不解析 worker、不入队
      if (!PERCEPTION_SOURCES.includes(payload.source)) {
        logger.warn(
          `[perception] 来源 ${payload.source} 不在白名单（${PERCEPTION_SOURCES.join("/")}），注入丢弃：→${payload.targetAgentId} sourceId=${payload.sourceId}`,
        );
        return false;
      }
      // ② waterfall 改写链：当前无中间件，内建放行 = 原样透传
      const resolved = await ctx.waterfall("perception/inject", payload, () => payload);
      // ③ 解析 worker：无可用 worker 时 warn 并跳过（沿用原各生产者文案语义：
      //    subagents「终态通知跳过」/ intermind「私信已落盘，唤醒跳过」）
      const worker = await ctx.agents.getOrCreateWorker(resolved.targetAgentId);
      if (!worker) {
        logger.warn(
          `[perception] ${resolved.source}→${resolved.targetAgentId} 感知注入跳过：目标无可用 worker，唤醒不触发（sourceId=${resolved.sourceId}）`,
        );
        return false;
      }
      // ④ 入队感知回合（先落热存储再入队的机制本体在 enqueueSystemNotice）
      worker.enqueueSystemNotice(resolved.text, resolved.sourceId, resolved.opts);
      return true;
    },
  } satisfies PerceptionFace);
}

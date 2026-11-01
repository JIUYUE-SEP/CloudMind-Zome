import type { Context } from "cordis";
import { logger } from "../../logger.js";
import type { AgentWorker, TurnHeartbeat } from "../../core/agent-worker.js";
import type { WatchdogSettings } from "../../config/repository.js";
import { judgeTurnProgress } from "./judge.js";

/**
 * 看门狗插件（P3）：turn 级停滞检测与中断。
 *
 * 为什么 L0（流空闲超时）不够：它管的是「单次 provider 请求多久没数据」。
 * 一个 turn 可能每一步都刚好在空闲阈值内返回（每步 170s，阈值 180s），
 * 二十步下来卡了近一小时，L0 一次都不会触发。这一层看的是**整个 turn
 * 有没有实质进展**——判据是心跳里的 `lastActivityAt`，它由三个点刷新：
 * 完成一个 step、工具开始、工具结束。
 *
 * 中断走的是与「用户点停止」完全相同的那条 signal（worker 内部用
 * `AbortSignal.any` 与外部取消合并），所以收尾语义（半截 step 丢弃、
 * turn.end 带 aborted.reason、不写交接书）全套复用，不需要第二套逻辑。
 *
 * 可摘除性：定时器挂 `ctx.effect` disposer，摘插件即停扫；服务经
 * `ctx.provide` 上架，路由侧按可选字段消费（见 api/context.ts 的
 * `watchdog?`），因此摘掉本插件不会让 http 插件卡在 PENDING。
 */

export const name = "watchdog";

/** 依赖 agents（遍历 worker 注册表）、config（读运行期阈值）、llm（语义审查造 provider） */
export const inject = ["agents", "config", "llm"];

/** 缺省：卡十分钟还没任何进展就该怀疑了 */
export const DEFAULT_STALL_THRESHOLD_MS = 600_000;
export const DEFAULT_SCAN_INTERVAL_MS = 30_000;
/** 语义审查冷却：同一 agent 两次审查至少隔两分钟，否则等于每轮扫描烧一次模型 */
export const DEFAULT_REVIEW_COOLDOWN_MS = 120_000;
/** 扫描周期下限：再密就是纯烧 CPU，且故障恢复不差这十秒 */
export const MIN_SCAN_INTERVAL_MS = 5_000;
/**
 * 工具自报上限之外的宽限：工具自己到点会抛错返回，但收尾（杀进程组、
 * 拼结果、落盘）还要时间。这一段不该算进「停滞」。
 */
export const TOOL_GRACE_MS = 60_000;

/** 单个在途 turn 的快照（GET /system/watchdog 的一条） */
export interface WatchdogTurnSnapshot {
  agentId: string;
  /** turn 开始（ISO 8601） */
  startedAt: string;
  /** 最近一次实质进展（ISO 8601） */
  lastActivityAt: string;
  /** 距最近一次进展的毫秒数——「到底是挂了还是只是慢」就看这个 */
  idleMs: number;
  /** 本次判定使用的阈值（已按 activeTool 放宽） */
  thresholdMs: number;
  stepCount: number;
  activeTool?: { name: string; timeoutMs?: number };
}

export interface WatchdogSnapshot {
  enabled: boolean;
  scanIntervalMs: number;
  stallThresholdMs: number;
  /** 语义审查配置（P4）：排查「为什么这个明显在打转的回合没被审」时先看这里 */
  semanticReview: { enabled: boolean; afterMs: number; cooldownMs: number };
  /** 在途 turn 列表；空数组表示当前没有任何回合在跑 */
  turns: WatchdogTurnSnapshot[];
}

/** ctx.watchdog 上架面 */
export interface WatchdogFace {
  /** 当前心跳快照（只读，供 GET /system/watchdog） */
  snapshot(): Promise<WatchdogSnapshot>;
}

/**
 * 组合根回调（P3）：把上架面回传一份。
 *
 * 为什么不让 http 插件 `inject: ["watchdog"]`：cordis 对未 inject 的服务
 * 访问即抛，inject 后 http 会硬依赖本插件——摘掉 watchdog 就让 http 永远
 * PENDING，整个 engine 起不来，与「可整体摘除」的设计承诺相悖。
 * 走回调则摘除后 http 拿到 undefined，端点如实报告 enabled:false。
 */
export interface Config {
  onProvide?: (face: WatchdogFace) => void;
}

declare module "cordis" {
  interface Context {
    watchdog: WatchdogFace;
  }
}

/** 阈值归一：非法/缺失一律回缺省，绝不让一个 0 或 NaN 把看护关成「永远不触发」 */
function normalizeThreshold(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_STALL_THRESHOLD_MS;
  }
  return Math.round(raw);
}

function normalizeInterval(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SCAN_INTERVAL_MS;
  }
  return Math.max(MIN_SCAN_INTERVAL_MS, Math.round(raw));
}

/**
 * 时长归一（语义审查的两个参数）：非法值用缺省，不因配置笔误关掉功能。
 *
 * 允许 0——`cooldownMs: 0` 是「不冷却」的显式表达（配合扫描周期即每轮一审），
 * 用户写 0 就是想要这个行为；只有负数/非数字才视为没配。
 */
function normalizePositive(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
  return Math.round(raw);
}

/**
 * 本次判定该用的阈值。
 *
 * 关键在工具在跑时要放宽——否则 `run_command` 跑十分钟（它自己的合法上限
 * 就是 600s）会被当成卡死杀掉。放宽量取工具**自报**的上限而非固定值：
 * 工具有多长的合法阻塞期，只有工具自己知道。
 *
 * 未声明 timeoutMs 的工具按缺省阈值判：它没有承诺过执行时长，看护没有
 * 依据放宽。这类工具要么补声明，要么接受长时间无进展被判定为卡死。
 */
function effectiveThresholdMs(heartbeat: TurnHeartbeat, base: number): number {
  const declared = heartbeat.activeTool?.timeoutMs;
  if (declared === undefined || declared <= 0) return base;
  return Math.max(base, declared + TOOL_GRACE_MS);
}

export function apply(ctx: Context, config?: Config): void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  /** 正在做语义审查的 agent（异步进行，防同一轮重复发起） */
  const reviewing = new Set<string>();
  /** 各 agent 上次审查时间（冷却用：反复审查等于反复烧 token） */
  const lastReviewAt = new Map<string, number>();

  async function readSettings(): Promise<{
    enabled: boolean;
    stallThresholdMs: number;
    scanIntervalMs: number;
    semantic: { enabled: boolean; afterMs: number; cooldownMs: number };
  }> {
    const config = await ctx.config.load();
    const settings: WatchdogSettings | undefined = config.settings?.watchdog;
    const stallThresholdMs = normalizeThreshold(settings?.stallThresholdMs);
    const semantic = settings?.semanticReview;
    return {
      // 缺省开：故障恢复不该要用户先去发现并手动打开
      enabled: settings?.enabled !== false,
      stallThresholdMs,
      scanIntervalMs: normalizeInterval(settings?.scanIntervalMs),
      semantic: {
        // 缺省关：会产生模型调用，不能在升级后自动开始烧用户的钱
        enabled: semantic?.enabled === true,
        // 缺省取硬阈值的一半：既给审查留出「早发现」的余地，又不至于
        // 稍微慢一点就调一次模型
        afterMs: normalizePositive(semantic?.afterMs, Math.floor(stallThresholdMs / 2)),
        cooldownMs: normalizePositive(semantic?.cooldownMs, DEFAULT_REVIEW_COOLDOWN_MS),
      },
    };
  }

  async function collectTurns(stallThresholdMs: number): Promise<WatchdogTurnSnapshot[]> {
    const turns: WatchdogTurnSnapshot[] = [];
    for (const worker of ctx.agents.workerRegistry.all()) {
      const heartbeat = worker.getHeartbeat();
      if (heartbeat === undefined) continue;
      turns.push({
        agentId: worker.agentId,
        startedAt: new Date(heartbeat.startedAt).toISOString(),
        lastActivityAt: new Date(heartbeat.lastActivityAt).toISOString(),
        idleMs: Date.now() - heartbeat.lastActivityAt,
        thresholdMs: effectiveThresholdMs(heartbeat, stallThresholdMs),
        stepCount: heartbeat.stepCount,
        ...(heartbeat.activeTool !== undefined ? { activeTool: { ...heartbeat.activeTool } } : {}),
      });
    }
    return turns;
  }

  /**
   * 语义审查（P4）：判定「动着但没在推进」。
   *
   * 与心跳扫描是两把尺子：心跳看「多久没动」，语义看「动了有没有用」。
   * 因此它的触发阈值低于硬阈值——目的就是在硬杀之前先把「在打转」的回合
   * 捞出来，而不是等到彻底静默。
   *
   * 全程 best-effort：任何一步失败都放行，绝不因为审查自己出问题而杀回合。
   */
  async function runSemanticReview(
    worker: AgentWorker,
    heartbeat: TurnHeartbeat,
    idleMs: number,
  ): Promise<void> {
    const agentId = worker.agentId;
    reviewing.add(agentId);
    lastReviewAt.set(agentId, Date.now());
    // 审查开始时的进展水位：结果回来时要拿它比对，见下方二次确认
    const baselineActivity = heartbeat.lastActivityAt;
    try {
      // 没有动作轨迹就没有判断依据，不必花一次模型调用
      if (heartbeat.trace === undefined || heartbeat.trace.steps.length === 0) return;

      const agentConfig = await ctx.agents.agentRepository.get(agentId);
      if (!agentConfig) return;
      const provider = await ctx.llm.createProvider(agentConfig);
      // 与 worker 的边界裁判同一条降级链：专门配了便宜模型就用它
      const model =
        agentConfig.topicBoundaryModel ?? agentConfig.compressionModel ?? agentConfig.model;
      // 没有可用模型就不审了——审查是增强，不该为此阻断任何东西
      if (model === undefined || model.length === 0) return;

      const verdict = await judgeTurnProgress(provider, model, heartbeat, idleMs);
      if (verdict !== "stuck") return;

      /**
       * 二次确认（关键）：审查期间回合可能已经恢复了。
       * 拿判定的输入快照与当前状态比——`lastActivityAt` 前进了就说明它
       * 在审查的这几十秒里又干了活，此时中断等于杀掉一个刚恢复的回合。
       */
      const latest = worker.getHeartbeat();
      if (latest === undefined) return;
      if (latest.lastActivityAt > baselineActivity) {
        logger.info(
          { agentId, stepCount: latest.stepCount },
          "[watchdog] 语义审查判 STUCK，但审查期间已有新进展，放行",
        );
        return;
      }

      if (!worker.abortCurrentTurn("stalled")) return;
      logger.warn(
        {
          agentId,
          stepCount: latest.stepCount,
          idleMs,
          turnElapsedMs: Date.now() - latest.startedAt,
          model,
          ...(latest.activeTool !== undefined ? { activeTool: latest.activeTool } : {}),
        },
        "[watchdog] 语义审查判定原地打转，已中断",
      );
    } catch (err) {
      logger.warn({ err, agentId }, "[watchdog] 语义审查异常（放行）");
    } finally {
      reviewing.delete(agentId);
    }
  }

  async function scanOnce(): Promise<void> {
    const settings = await readSettings();
    if (!settings.enabled) return;

    // 取一次时间基准：逐个 worker 各取一次 now，长扫描时后半段会偏晚，
    // 判定阈值附近可能出现「同一轮里先后不一致」
    const now = Date.now();
    for (const worker of ctx.agents.workerRegistry.all()) {
      const heartbeat = worker.getHeartbeat();
      if (heartbeat === undefined) continue;

      const idleMs = now - heartbeat.lastActivityAt;
      const thresholdMs = effectiveThresholdMs(heartbeat, settings.stallThresholdMs);

      if (idleMs >= thresholdMs) {
        // 先摘心跳再 abort 没必要——abort 后 job 的 finally 会清空，而这之间
        // 的时间窗里重复扫描也只是再 abort 一次（对已 abort 的 signal 是 no-op）
        if (!worker.abortCurrentTurn("watchdog")) continue;

        // 不含对话内容（与审批审计同口径）：只留定位用的结构字段
        logger.warn(
          {
            agentId: worker.agentId,
            stepCount: heartbeat.stepCount,
            idleMs,
            thresholdMs,
            turnElapsedMs: now - heartbeat.startedAt,
            ...(heartbeat.activeTool !== undefined ? { activeTool: heartbeat.activeTool } : {}),
          },
          "[watchdog] turn 停滞超阈值，已中断",
        );
        continue;
      }

      // 语义审查（P4）：还没到硬阈值，但已经不短了——先问一句「有用吗」
      if (!settings.semantic.enabled) continue;
      if (idleMs < settings.semantic.afterMs) continue;
      if (reviewing.has(worker.agentId)) continue;
      const reviewedAt = lastReviewAt.get(worker.agentId);
      if (reviewedAt !== undefined && now - reviewedAt < settings.semantic.cooldownMs) continue;

      // 异步发起，不阻塞本轮扫描（审查要调模型，几十秒起步）
      void runSemanticReview(worker, heartbeat, idleMs);
    }
  }

  async function tick(): Promise<void> {
    if (!running) return;
    let intervalMs = DEFAULT_SCAN_INTERVAL_MS;
    try {
      await scanOnce();
      intervalMs = (await readSettings()).scanIntervalMs;
    } catch (err) {
      // 看护自身故障不能把进程带崩：记一笔，下一轮继续
      logger.error({ err }, "[watchdog] 扫描失败");
    }
    if (!running) return;
    timer = setTimeout(() => void tick(), intervalMs);
    // 不阻止进程退出：关停时不该等一个看护定时器
    timer.unref?.();
  }

  const face: WatchdogFace = {
    async snapshot(): Promise<WatchdogSnapshot> {
      const settings = await readSettings();
      return {
        enabled: settings.enabled,
        scanIntervalMs: settings.scanIntervalMs,
        stallThresholdMs: settings.stallThresholdMs,
        semanticReview: { ...settings.semantic },
        turns: await collectTurns(settings.stallThresholdMs),
      };
    },
  };

  ctx.provide("watchdog", face satisfies WatchdogFace);
  config?.onProvide?.(face);

  ctx.effect(() => {
    running = true;
    void tick();
    return () => {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  });
}

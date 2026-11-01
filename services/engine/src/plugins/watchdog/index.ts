import type { Context } from "cordis";
import { logger } from "../../logger.js";
import type { TurnHeartbeat } from "../../core/agent-worker.js";
import type { WatchdogSettings } from "../../config/repository.js";

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

/** 依赖 agents（要遍历 worker 注册表）与 config（读运行期阈值） */
export const inject = ["agents", "config"];

/** 缺省：卡十分钟还没任何进展就该怀疑了 */
export const DEFAULT_STALL_THRESHOLD_MS = 600_000;
export const DEFAULT_SCAN_INTERVAL_MS = 30_000;
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

  async function readSettings(): Promise<{
    enabled: boolean;
    stallThresholdMs: number;
    scanIntervalMs: number;
  }> {
    const config = await ctx.config.load();
    const settings: WatchdogSettings | undefined = config.settings?.watchdog;
    return {
      // 缺省开：故障恢复不该要用户先去发现并手动打开
      enabled: settings?.enabled !== false,
      stallThresholdMs: normalizeThreshold(settings?.stallThresholdMs),
      scanIntervalMs: normalizeInterval(settings?.scanIntervalMs),
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
      if (idleMs < thresholdMs) continue;

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

import { logger } from "../logger.js";
import {
  isActiveHandoff,
  makeHandoffId,
  type HandoffBookInfo,
  type HandoffRecord,
  type HandoffStatus,
} from "./types.js";
import type { HandoffStateStore } from "./state.js";

/**
 * 合法状态转移表（P3 顺手包）：
 * 终态（completed/fused/aborted/lost）不可再转移——P1-1 的 aborted→completed
 * 覆盖就是靠这条防线兜底；record() 重建 pending 是"新链"语义，不走 markStatus。
 */
const HANDOFF_TRANSITIONS: Record<HandoffStatus, readonly HandoffStatus[]> = {
  pending: ["scheduled", "running", "fused", "aborted", "lost"],
  scheduled: ["running", "fused", "aborted", "lost"],
  running: ["completed", "fused", "aborted", "lost"],
  completed: [],
  fused: [],
  aborted: [],
  lost: [],
};

export interface HandoffManagerDeps {
  store: HandoffStateStore;
  /** 状态变化事件（ws 层转成 handoff.update 帧；失败只记 warn 不阻断落盘） */
  onUpdate?: (record: HandoffRecord) => void;
}

/**
 * 换班移交控制面（handoff-state.json）：
 * - record：撞顶产出交接书 → 建/更新活跃条目（agent+session 维度单条目）；
 * - markStatus：scheduled/running/completed/fused/aborted 等状态机转移；
 * - cancel：用户消息/disconnect 打断（活跃条目标 aborted）；
 * - load：启动对账（活跃条目标 lost，同 subagent 语义——现场已毁交人工）。
 *
 * 调度/保险丝/abort 的时序逻辑在 HandoffResumeLoop（ws 层），本类只做
 * 事实落盘与状态机，两侧解耦可单测。
 */
export class HandoffManager {
  private records = new Map<string, HandoffRecord>();

  constructor(private deps: HandoffManagerDeps) {}

  /** 启动加载：活跃条目标 lost 后回填内存索引 */
  async load(): Promise<void> {
    const lost = await this.deps.store.markActiveAsLost();
    if (lost > 0) {
      logger.warn(`[handoff] 启动对账：${lost} 个活跃换班条目标记为 lost（重启后不再自动续跑）`);
    }
    const records = await this.deps.store.loadAll();
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  /** 撞顶交接书入控制面：同一 agent+session 复用稳定 id，覆盖为最新棒次 */
  async record(info: HandoffBookInfo): Promise<HandoffRecord> {
    const now = Date.now();
    const id = makeHandoffId(info.agentId, info.sessionId);
    const existing = this.records.get(id);
    const record: HandoffRecord = {
      id,
      agentId: info.agentId,
      sessionId: info.sessionId,
      reason: info.reason ?? "watermark",
      status: "pending",
      shift: info.shift,
      maxShifts: info.maxShifts,
      ...(info.bookMessageId !== undefined ? { bookMessageId: info.bookMessageId } : {}),
      bookText: info.bookText,
      used: info.used,
      window: info.window,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    delete record.abortReason;
    this.records.set(id, record);
    await this.persist();
    this.deps.onUpdate?.(record);
    return record;
  }

  async markStatus(
    id: string,
    status: HandoffStatus,
    extra?: { resumeJobId?: string; abortReason?: string },
  ): Promise<HandoffRecord | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    const allowed = HANDOFF_TRANSITIONS[record.status];
    if (!allowed.includes(status)) {
      throw new Error(`invalid handoff transition: ${record.status} -> ${status}`);
    }
    record.status = status;
    record.updatedAt = Date.now();
    if (extra?.resumeJobId !== undefined) record.resumeJobId = extra.resumeJobId;
    if (extra?.abortReason !== undefined) record.abortReason = extra.abortReason;
    if (status === "completed" || status === "fused" || status === "aborted" || status === "lost") {
      delete record.resumeJobId;
    }
    await this.persist();
    this.deps.onUpdate?.(record);
    return record;
  }

  /** 用户消息/断连打断：该 agent+session 全部活跃条目标 aborted */
  async cancel(
    agentId: string,
    sessionId: string,
    reason: string,
  ): Promise<HandoffRecord[]> {
    const id = makeHandoffId(agentId, sessionId);
    const record = this.records.get(id);
    if (!record || !isActiveHandoff(record.status)) return [];
    return [
      (await this.markStatus(id, "aborted", { abortReason: reason }))!,
    ];
  }

  /** REST 手动打断（与用户消息打断同语义，原因标注 manual） */
  async abort(id: string, reason = "manual"): Promise<HandoffRecord | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (!isActiveHandoff(record.status)) return record;
    return this.markStatus(id, "aborted", { abortReason: reason });
  }

  get(id: string): HandoffRecord | undefined {
    return this.records.get(id);
  }

  list(filter?: { agentId?: string; sessionId?: string }): HandoffRecord[] {
    const records = Array.from(this.records.values()).sort((a, b) => a.updatedAt - b.updatedAt);
    if (!filter) return records;
    return records.filter(
      (r) =>
        (filter.agentId === undefined || r.agentId === filter.agentId) &&
        (filter.sessionId === undefined || r.sessionId === filter.sessionId),
    );
  }

  activeFor(agentId: string, sessionId: string): HandoffRecord | undefined {
    const record = this.records.get(makeHandoffId(agentId, sessionId));
    return record && isActiveHandoff(record.status) ? record : undefined;
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.store.save(Array.from(this.records.values()));
    } catch (err) {
      logger.warn({ err }, "[handoff] handoff-state.json 落盘失败（内存态保持）");
    }
  }
}

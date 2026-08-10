import type { HandoffStatus } from "@mindcloud/shared";

export type { HandoffStatus };

/** 棒数保险丝：缺省最多 5 棒（换班续跑上限），clamp 1-10（worker 侧归一） */
export const HANDOFF_DEFAULT_MAX_SHIFTS = 5;
export const HANDOFF_MAX_SHIFTS_MIN = 1;
export const HANDOFF_MAX_SHIFTS_MAX = 10;

/** 续跑入队前的默认延迟（给前端"换班中"可感知窗口；测试可注入 0） */
export const HANDOFF_RESUME_DELAY_MS = 600;

/** handoff-state.json 单条记录（控制面：换班移交的持久化事实） */
export interface HandoffRecord {
  /** 稳定 id（agent+session 维度，一个活跃条目） */
  id: string;
  agentId: string;
  sessionId: string;
  reason: "watermark";
  status: HandoffStatus;
  /** 最近一次撞顶的棒次（首棒 1；续跑递增） */
  shift: number;
  /** 棒数保险丝上限 */
  maxShifts: number;
  /** 交接书消息 id（消息载体；落历史可查） */
  bookMessageId?: string;
  /** 交接书正文（置顶注入与跨重启恢复用） */
  bookText: string;
  used: number;
  window: number;
  createdAt: number;
  updatedAt: number;
  /** 续跑 job id（status=running 时有） */
  resumeJobId?: string;
  /** 终态成因（aborted/lost 时填写） */
  abortReason?: string;
}

/** handoff-state.json 文件形状（DocumentStore 盖 schemaVersion） */
export interface HandoffStateFile {
  handoffs: HandoffRecord[];
}

/** 活跃（可被打断/续跑）的状态集合 */
export const ACTIVE_HANDOFF_STATUSES: readonly HandoffStatus[] = [
  "pending",
  "scheduled",
  "running",
];

export function isActiveHandoff(status: HandoffStatus): boolean {
  return ACTIVE_HANDOFF_STATUSES.includes(status);
}

/** 同一 agent+session 只保留一个活跃条目（换棒更新，不堆积记录） */
export function makeHandoffId(agentId: string, sessionId: string): string {
  return `ho_${agentId}_${sessionId}`;
}

/** 换班移交信息（runTurn 撞顶产出 → manager.record 入控制面） */
export interface HandoffBookInfo {
  agentId: string;
  sessionId: string;
  reason: "watermark";
  shift: number;
  maxShifts: number;
  used: number;
  window: number;
  bookMessageId?: string;
  bookText: string;
  /**
   * 链代际标记（F1）：同一换班链（首棒+各续跑棒）共用同一个 id；
   * abort 后新用户消息开的新链经 beginNewChain 换新 id。入口闩锁据此
   * 区分「abort 之前旧链的迟到 book」与「abort 之后新链的正常 book」。
   */
  chainId?: string;
}

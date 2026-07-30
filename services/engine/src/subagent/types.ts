import type { ChatMessage } from "@mindcloud/shared";

/** 子 agent 分型：delegate=借用人形（现状语义）；puppet=傀儡（无 SOUL/无记忆，2b 才分化执行路径，本包仅埋 schema） */
export type SubagentTaskKind = "puppet" | "delegate";

/** lost：重启前仍处于 running 的任务——现场已毁、不知死活≠已知失败，需人工决策而非自动续跑 */
export type SubagentTaskStatus = "running" | "completed" | "failed" | "lost";

export interface SubagentTask {
  id: string;
  parentAgentId: string;
  taskDescription: string;
  messages: ChatMessage[];
}

export interface SubagentResult {
  taskId: string;
  /** 子 agent 的最终文本输出 */
  output: string;
  error?: string;
}

export interface SubagentOptions {
  mode: "foreground" | "background";
  timeoutMs?: number;
  /** 缺省 "delegate"（兼容现状）；kind=puppet 在 2b 前按 delegate 同等执行 */
  kind?: SubagentTaskKind;
}

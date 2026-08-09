/**
 * web ↔ engine 协议类型（P5-2）：WS 控制帧与 REST DTO 的权威定义。
 * 此前两端各手写一份且已发生 3 组实际漂移（架构 review 协议一致性域 Major），
 * 收敛为单一来源后，任一侧改字段都会在对端编译期报错。
 *
 * 流式事件帧（text.delta / thinking.delta / tool.call / tool.result /
 * step.end / turn.end）是 engine 内部的 LLMEvent（provider/types.ts），
 * 只有 engine 一份定义，不在此重复；本文件收控制帧（此前连 engine 侧都无类型）。
 */
import type { ChatMode, ToolCall } from "./index.js";

// ---- WS 控制帧：server → client ----

/** 危险工具审批请求（群聊帧外层额外携带 agentId） */
export interface ApprovalRequestFrame {
  type: "tool.approval_request";
  approvalId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  agentId?: string;
}

/** 模式切换确认（仅会话 WS） */
export interface SessionModeChangedFrame {
  type: "session.mode_changed";
  mode: ChatMode;
  projectId?: string;
}

/**
 * 换班移交状态（水位撞顶自动续跑的控制面状态）。
 * 权威定义在 engine（handoff/types.ts），跨 WS 帧与 REST DTO 共用此类型，
 * 防止两端再次漂移。
 */
export type HandoffStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "completed"
  | "aborted"
  | "fused"
  | "lost";

/** 换班移交状态帧（水位撞顶 → 交接书 → 自动续跑/保险丝/abort 的可见化） */
export interface HandoffUpdateFrame {
  type: "handoff.update";
  /** 群聊帧外层可额外携带 agentId */
  agentId?: string;
  status: HandoffStatus;
  /** 当前（最近一次撞顶的）棒次 */
  shift: number;
  /** 棒数保险丝上限 */
  maxShifts: number;
  /** 交接书消息 id（消息载体；落历史可查） */
  bookMessageId?: string;
  /** 状态成因（user_message / manual / disconnect / engine_restart 等） */
  reason?: string;
}

/** 错误帧（群聊帧外层可额外携带 agentId） */
export interface WsErrorFrame {
  type: "error";
  error: string;
  agentId?: string;
}

// ---- WS 控制帧：client → server ----

/** 审批回执（remember 对 NO_REMEMBER_TOOLS 四工具无效，见 constants.ts） */
export interface ApprovalResponseFrame {
  type: "tool.approval";
  approvalId: string;
  approved: boolean;
  remember: boolean;
}

/** 切换 chat / code 模式（仅会话 WS） */
export interface SessionSetModeFrame {
  type: "session.set_mode";
  mode: ChatMode;
  projectId?: string;
}

/** 聊天消息帧（无 type 字段，最长 10000 字符） */
export interface ChatTextFrame {
  text: string;
}

// ---- REST DTO（engine 为权威形状）----

/**
 * 消息记录（engine `memory/repositories/types.ts` 原定义为权威：role 含
 * "system"、必有 sessionId）。`agentId` 只在群聊历史合并时由引擎标注
 * （assistant/tool 消息归属），user 消息与私聊历史不带。
 */
export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  agentId?: string;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  modelType: "llm" | "embedding" | "image" | "stt";
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
  supportsToolCalling?: boolean;
  supportsMultimodal?: boolean;
}

/**
 * Provider 配置（engine `config/repository.ts` 原定义为权威，含
 * requestTimeout/maxRetries）。REST 返回时 apiKey 脱敏为 "***"；
 * web 曾另发明的 hasApiKey 字段 engine 从未返回，已随收敛删除。
 */
export interface ProviderConfig {
  id: string;
  displayName: string;
  providerType: "openai";
  baseUrl: string;
  apiKey?: string;
  models: ModelInfo[];
  requestTimeout?: number;
  maxRetries?: number;
  /**
   * 协议族选择（2026-08-08）：responses（POST {baseURL}/responses，主路新推荐）/
   * anthropic（POST {baseURL}/anthropic/v1/messages，主路）/
   * chat_completions（兼容层，缺省；现有配置零破坏）。
   */
  apiMode?: "responses" | "anthropic" | "chat_completions";
}

/**
 * 定时任务（engine `scheduler/types.ts` 原定义为权威：
 * createdAt/updatedAt 必填——引擎创建时盖章，web 曾误标为可选）。
 */
export interface ScheduledTask {
  id: string;
  agentId: string;
  description: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

import type { ChatMessage } from "@cloudmind/shared";

export interface TextDeltaEvent {
  type: "text.delta";
  delta: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking.delta";
  delta: string;
}

export interface ToolCallEvent {
  type: "tool.call";
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultEvent {
  type: "tool.result";
  toolCallId: string;
  output: unknown;
}

export interface StepEndEvent {
  type: "step.end";
  finishReason?: string;
  /** token 用量（P4-5 落档）：provider 流式返回 usage 时透传；无则不携带 */
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * 一轮（turn）结束：正常路径由 runTurn 在 ReAct 循环退出后发出（含 maxSteps
 * 耗尽）；异常路径（provider/工具抛错、abort）由 AgentWorker 在 catch 补发
 * （P3-1）——语义为"本轮生成终止"（含异常终止），两条路径互斥不双发。
 * 与 step.end 区分——后者每个 loop step 都会发，tool_use 时循环继续；
 * 前端应只在 turn.end / error / close 时复位"生成中"状态。
 */
/**
 * 回合中断原因（2026-11-01 P2）：终帧带它，前端才能把气泡标成「已中断」而不是
 * 当成正常结束或故障。取值来自 signal.reason，认不出时回落 "user"（现有创建方
 * ——plans / blueprint / handoff / watchdog——都是主动取消）。
 *
 * `stalled` 与 `watchdog` 分开：前者是 P4 语义审查判定「在打转/偏题」，
 * 后者是 P3 心跳超阈值（长时间没有任何进展）。两者都归看护，但一个说的是
 * 「动着但没用」，一个说的是「根本不动」——排查时这个区分值钱。
 */
export type TurnAbortReason = "user" | "watchdog" | "stalled" | "timeout" | "shutdown";

export interface TurnEndEvent {
  type: "turn.end";
  /**
   * 仅在**被中断**时出现；正常结束不带该字段（保持既有帧形状不变，
   * 老前端零改动）。语义是「本轮生成终止且非正常收尾」。
   */
  aborted?: { reason: TurnAbortReason };
}

/**
 * 水位撞顶换班移交（交接书消息载体）：runTurn 撞顶兜底后由 AgentWorker
 * 在 job.onEvent 上补发。携带棒次/保险丝与交接书正文——WS 层的续跑循环
 * 据此落 handoff-state.json 并调度下一棒；前端不直接消费本帧（由
 * handoff.update 状态帧呈现），但转发也不破坏协议。
 */
export interface HandoffBookEvent {
  type: "handoff.book";
  /** 本次撞顶所属棒次（首棒 1，续跑递增） */
  shift: number;
  /** 棒数保险丝上限 */
  maxShifts: number;
  used: number;
  window: number;
  /** 交接书消息 id（消息载体；落历史可查，控制面记录用） */
  bookMessageId: string;
  /** 交接书正文（消息载体文本，落历史且供置顶注入） */
  bookText: string;
  /** 链代际标记（F1）：ws 层入队时按 beginNewChain 代际打标，续跑循环据此做闩锁判定 */
  chainId?: string;
}

export type LLMEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepEndEvent
  | TurnEndEvent
  | HandoffBookEvent;

export interface LLMChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /**
   * 外部取消信号（控制面，非数据面）：abort 时立即中断在途请求。
   *
   * 2026-11-01 P2：此前 signal 只到 runTurn 的循环顶部检查，正在进行的
   * LLM 调用无法被打断——中断必须等当前步自然结束。把 signal 放进 params
   * 而非加第二参数，是为了让 resilient / record-calls / ModelApiModeRouter
   * 三层包装原样透传，零改动。与协议层的空闲超时互补：空闲超时管「多久
   * 没数据」，本信号管「调用方要求立刻停」。
   */
  signal?: AbortSignal;
}

/**
 * F1：LLM 协议族标识（只读）。水位预检按协议决定 think 块是否占窗口：
 * chat_completions 请求回传时过滤 think；anthropic/responses 会真回传。
 * 未声明（旧实现/测试桩）时按保守口径处理（think 计入）。
 */
export type LLMProviderProtocol = "chat_completions" | "anthropic" | "responses";

export interface LLMProvider {
  name: string;
  /** F1：协议族标识（只读）；未声明时水位预检按保守口径（含 think）处理 */
  readonly protocol?: LLMProviderProtocol;
  /**
   * R2（B 方案不变量）：协议预检口径的主型号（ModelApiModeRouter 暴露）。
   * runTurn 必须始终以该型号发起——protocol() 单值口径与逐型号路由的绑定
   * 假设；未声明（旧实现/测试桩）时 runTurn 不做一致性检查。
   */
  readonly defaultModel?: string;
  /**
   * R1（型号表热更新）：在 runTurn 预检前刷新协议/路由口径（Router 从活配置
   * 重算 defaultModel 的生效协议）；可选，旧实现缺省跳过。
   */
  refresh?(): Promise<void>;
  chat(params: LLMChatParams): AsyncIterable<LLMEvent>;
  supportsModel(model: string): boolean;
}

export interface EmbedderProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
  supportsModel(model: string): boolean;
}

export interface ImageGenProvider {
  name: string;
  generate(
    prompt: string,
    /** model：工具参数临时覆盖型号（决策 1）；缺省由 provider 默认型号兜底 */
    options?: { size?: string; model?: string }
  ): Promise<{ url?: string; data?: string }>;
  supportsModel(model: string): boolean;
}

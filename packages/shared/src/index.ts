export type ChatMode = "chat" | "code";

export interface AgentConfig {
  id: string;
  name: string;
  codename?: string;
  description?: string;
  persona: string;
  tags?: string[];
  representColor?: string;
  providerId?: string;
  modelId?: string;
  model?: string; // fallback for old configs
  embedderProviderId?: string;
  embedderModelId?: string;
  imageProviderId?: string;
  imageModelId?: string;
  temperature?: number;
  topP?: number;
  /** 上下文窗口总预算（token），缺省由引擎按 80000 处理；32k/128k 窗口模型应显式配置 */
  maxContextTokens?: number;
  /** 话题压缩模型；缺省用主模型，压缩失败不 fallback（ContextPipeline Phase 2） */
  compressionModel?: string;
  /** 话题检测时间窗（分钟）：超过该间隔无交互视为新话题，缺省 30 */
  topicDetectionWindowMinutes?: number;
  /** 当前话题消息数达到该阈值即关闭并压缩，缺省 20 */
  topicMessageThreshold?: number;
  /** 语义检索开关（L4），缺省 true（仍需配置 embedder 才生效） */
  semanticSearchEnabled?: boolean;
  /** L4 注入条数上限，缺省 10 */
  semanticTopK?: number;
  /** L4 最低相关度（向量相似度 × 时间衰减，0-1），缺省 0 不过滤 */
  semanticMinScore?: number;
  skills: string[];
  tools: string[];
}

export interface ToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * 流式中断落盘的半截消息标记（P3-3）：provider 抛错时已上屏的部分生成
   * 内容以半截 assistant 消息持久化（与用户所见一致），此标记供排查识别；
   * 对 ContextPipeline/检索它是普通 assistant 消息。
   */
  incomplete?: boolean;
  createdAt: string;
}

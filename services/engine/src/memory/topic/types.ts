import type { ChatMessage } from "@mindcloud/shared";

/** 一个已关闭、待压缩的话题片段 */
export interface TopicSegment {
  /** tp_<timestamp>_<rand> */
  topicId: string;
  messages: ChatMessage[];
  /** 场景 ID（sessionId） */
  sourceId: string;
  sourceName?: string;
  startedAt: string;
  endedAt: string;
  /**
   * true 时只做归档、不调用 LLM 生成摘要（短话题）：
   * 保证热存储有界，又不为两三句话浪费一次压缩调用
   */
  archiveOnly?: boolean;
}

/** 压缩档：frontmatter 元数据 + 正文，落盘为 _compressed/{topicId}.md */
export interface CompressedTopic {
  topicId: string;
  /** 话题主题（LLM 生成或兜底"（未命名话题）"） */
  label: string;
  /** LLM 生成的摘要全文（主题 + 关键结论） */
  summary: string;
  keyPoints: string[];
  msgIds: string[];
  msgCount: number;
  /** v1 恒 normal；LLM 重要性标记留 v2 */
  importance: "high" | "normal" | "low";
  sourceId: string;
  sourceName?: string;
  compressedAt: string;
  /** 预留：Phase 3 接向量索引后反查 */
  embeddingId?: string;
}

export interface TopicCompressionConfig {
  /** 默认 true；false 时 tracker 不产出 segment */
  enabled: boolean;
  /** 压缩模型；缺省用主模型。指定后压缩失败不 fallback（设计决策 2） */
  compressionModel?: string;
  /** 时间间隔超过该分钟数视为新话题，默认 30 */
  windowMinutes: number;
  /** 当前话题消息数达到该阈值即关闭压缩，默认 20 */
  messageThreshold: number;
  /** 注入最近压缩档数量（L5），默认 2 */
  hotMemoryCount: number;
}

export const DEFAULT_TOPIC_COMPRESSION_CONFIG: TopicCompressionConfig = {
  enabled: true,
  windowMinutes: 30,
  messageThreshold: 20,
  hotMemoryCount: 2,
};

/** 短话题不调用 LLM 压缩（一两句话就产一个压缩档只会制造噪声），仅归档 */
export const MIN_SEGMENT_MESSAGES = 4;

/**
 * 配置归一：非法取值会造成静默失效（threshold < MIN 时压缩永不发生、
 * windowMinutes <= 0 时每条消息都切话题），clamp 并 warn，不放任。
 */
export function normalizeTopicCompressionConfig(
  partial: Partial<TopicCompressionConfig> = {},
): TopicCompressionConfig {
  const config = { ...DEFAULT_TOPIC_COMPRESSION_CONFIG, ...partial };
  if (config.messageThreshold < MIN_SEGMENT_MESSAGES) {
    console.warn(
      `[topic] messageThreshold=${config.messageThreshold} 小于最短压缩段 ${MIN_SEGMENT_MESSAGES}，已按 ${MIN_SEGMENT_MESSAGES} 处理`,
    );
    config.messageThreshold = MIN_SEGMENT_MESSAGES;
  }
  if (config.windowMinutes <= 0) {
    console.warn(
      `[topic] windowMinutes=${config.windowMinutes} 非法，已按默认 ${DEFAULT_TOPIC_COMPRESSION_CONFIG.windowMinutes} 处理`,
    );
    config.windowMinutes = DEFAULT_TOPIC_COMPRESSION_CONFIG.windowMinutes;
  }
  if (config.hotMemoryCount < 0) config.hotMemoryCount = 0;
  return config;
}

/** 提取消息的全部文本内容（检测/压缩 prompt 共用） */
export function messageText(msg: ChatMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

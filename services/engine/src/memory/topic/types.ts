import { logger } from "../../logger.js";
import type { ChatMessage } from "@cloudmind/shared";

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
  /** 阶段 5 二期：本话题内 Skill 工具成功调用过的技能名（去重），写入摘要作活跃保护 */
  usedSkills?: string[];
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
  /** P4-a 起由压缩调用真实赋值（它能看全段内容）；解析失败/缺省回落 normal */
  importance: "high" | "normal" | "low";
  sourceId: string;
  sourceName?: string;
  compressedAt: string;
  /** 话题起止时间（recall 浏览记忆目录用；旧档无字段时回退 compressedAt） */
  startedAt?: string;
  endedAt?: string;
  /** 预留：Phase 3 接向量索引后反查 */
  embeddingId?: string;
  /** Phase 7：同一次压缩调用顺手提取的经验（0-N 条，没有为空数组） */
  experiences?: ExtractedExperience[];
  /**
   * P4-a memory flush：同一次压缩调用顺手提取的长期记忆事实（0-5 条，没有为空数组）。
   * 与 MIND 经验分工：memories 沉淀事实（"发生了什么值得记住的事"），
   * MIND 沉淀经验/偏好（"我学到什么"）。由调用方在归档成功后落 memories.jsonl
   * 并 embed 入向量索引（doc_id `mem:<recordId>`，L4 可召回）。
   */
  memoryFacts?: MemoryFact[];
  /** 阶段 5 二期：本话题内 Skill 工具成功调用过的技能名（活跃保护，组装自动重取依据） */
  usedSkills?: string[];
}

/**
 * 从话题中提取的一条经验（Phase 7）。
 * 颗粒度为经验/教训/偏好（如"指挥官讨厌 emoji"），不是事实流水账。
 */
export interface ExtractedExperience {
  title: string;
  text: string;
  /** 0-1（解析时已 clamp）；写入 MIND.md 时 ≤ 0.5 直接不落盘 */
  confidence: number;
}

/**
 * 从话题中提取的一条长期记忆事实（P4-a）。
 * 颗粒度为事实/决策/情感表达（如"指挥官定稿用方案 C"），一句话一条。
 */
export interface MemoryFact {
  text: string;
  /** 0-1（解析时已 clamp）；flush 落盘时 ≤ 0.5 直接不写（与 MIND 经验同口径） */
  confidence: number;
}

export interface TopicCompressionConfig {
  /** 默认 true；false 时 tracker 不产出 segment */
  enabled: boolean;
  /** 压缩模型；缺省用主模型。指定后压缩失败不 fallback（设计决策 2） */
  compressionModel?: string;
  /** 话题边界裁判/压缩前复核模型；缺省用 compressionModel，再缺省用主模型 */
  boundaryModel?: string;
  /** 双程压缩（P4-c）：true 时压缩走草稿→修订两程；默认 false（Agent 级开关缺省关，灰度） */
  twoPass: boolean;
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
  // P4-c：双程压缩缺省关（灰度观察质量收益后再议默认开）
  twoPass: false,
};

/** 短话题不调用 LLM 压缩（一两句话就产一个压缩档只会制造噪声），仅归档 */
export const MIN_SEGMENT_MESSAGES = 4;

/**
 * 话题边界 LLM 裁判的判决间隔（方案 C 六点定案 1）：
 * 每攒 6 轮判一次（一轮 = 一条用户消息 + 一条助手回复；tool 消息不计数）。
 */
export const JUDGE_ROUND_INTERVAL = 6;

/**
 * 配置归一：非法取值会造成静默失效（threshold < MIN 时压缩永不发生、
 * windowMinutes <= 0 时每条消息都切话题），clamp 并 warn，不放任。
 */
export function normalizeTopicCompressionConfig(
  partial: Partial<TopicCompressionConfig> = {},
): TopicCompressionConfig {
  const config = { ...DEFAULT_TOPIC_COMPRESSION_CONFIG, ...partial };
  if (config.messageThreshold < MIN_SEGMENT_MESSAGES) {
    logger.warn(
      `[topic] messageThreshold=${config.messageThreshold} 小于最短压缩段 ${MIN_SEGMENT_MESSAGES}，已按 ${MIN_SEGMENT_MESSAGES} 处理`,
    );
    config.messageThreshold = MIN_SEGMENT_MESSAGES;
  }
  if (config.windowMinutes <= 0) {
    logger.warn(
      `[topic] windowMinutes=${config.windowMinutes} 非法，已按默认 ${DEFAULT_TOPIC_COMPRESSION_CONFIG.windowMinutes} 处理`,
    );
    config.windowMinutes = DEFAULT_TOPIC_COMPRESSION_CONFIG.windowMinutes;
  }
  if (config.hotMemoryCount < 0) config.hotMemoryCount = 0;
  if (config.boundaryModel !== undefined && config.boundaryModel.trim() === "") {
    logger.warn(
      `[topic] boundaryModel 为空串，回退 compressionModel/主模型`,
    );
    config.boundaryModel = undefined;
  }
  return config;
}

/** 提取消息的全部文本内容（检测/压缩 prompt 共用） */
export function messageText(msg: ChatMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

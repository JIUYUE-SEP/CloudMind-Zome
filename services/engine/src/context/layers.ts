import type { ChatMessage } from "@mindcloud/shared";
import type { MindChunk } from "../mind/mind-files.js";

/** L6 工具 schema（Phase 1 不依赖内部结构，token 计数按 JSON 序列化） */
export type ToolSchema = unknown;

/** L4 语义检索结果（Phase 3）：单条记忆片段 */
export interface SemanticMemory {
  id: string;
  content: string;
  /** 最终相关度 = 向量相似度 × 时间衰减；按降序排列，降级时优先保留前部 */
  score: number;
  /** 跨场景来源标注（session id）；与当前场景相同时为空 */
  source?: string;
  createdAt: string;
}

/** L5 话题摘要（结构化）：自然化注入与多轮去重的最小信息集 */
export interface TopicSummary {
  /** 压缩档 topicId（多轮去重键） */
  id: string;
  /** 话题主题（LLM 生成或兜底"（未命名话题）"） */
  label: string;
  /** 摘要正文（summary + 关键结论，不含 label 与元信息包装） */
  text: string;
  /** 压缩时间：注入消息的时间戳来源（时间真实，心智可算时间差） */
  createdAt: string;
  /** 阶段 5 二期：该话题内使用过的技能名（活跃保护——组装时自动重取规程正文） */
  usedSkills?: string[];
  /** P4-b：话题重要性（压缩调用赋值）；存量档无此字段时按 normal 语义（undefined） */
  importance?: "high" | "normal" | "low";
}

/**
 * 上下文分层（设计文档 docs/design/context-pipeline-v2.md 第二节）。
 *
 * 可压缩性决策（不可变更）：
 * - L1（人格）/ L6-core（核心工具）：永不压缩
 * - L5（话题摘要）/ L4（语义检索）/ L6-ext（扩展工具）/ L3（热上下文）：可按降级序列裁剪
 *
 * M7：L2（@提及提醒）层已删除——mentionDesc 自始至终无生产者（群聊 mention
 * 路由信息未接线进 pipeline），属死输入清理；未来若接线群聊 @ 提醒再恢复该层。
 */
export interface ContextLayers {
  /** L1 人格文件内容（SOUL.md + skill 索引；不含 MIND.md） */
  l1: string;
  /** L3 热上下文（当前场景近期消息），降级时从最旧处截断 */
  l3: ChatMessage[];
  /** MIND.md 经验检索命中块（伪装成 assistant 历史消息，注入 L3 之后；Phase 1 不参与降级） */
  mind: MindChunk[];
  /** L4 语义检索结果（按 score 降序，降级保留前部；伪装成历史消息注入 messages） */
  l4: SemanticMemory[];
  /** L5 话题摘要（按时间倒序，最新在前；伪装成历史消息注入 messages） */
  l5: TopicSummary[];
  /** L6-core 核心工具描述（文件读写/bash/edit 等基础能力） */
  l6Core: ToolSchema[];
  /** L6-ext 扩展工具描述（MCP/subagent 专用等；Phase 1 恒空，预留裁剪槽位） */
  l6Ext: ToolSchema[];
}

/** 参与降级的层（其余层永不触碰） */
export type CompressibleLayer = "l5" | "l4" | "l6Ext" | "l3";

/** 降级顺序（设计决策）：L5 → L4 → L6-ext → L3 */
export const DOWNGRADE_ORDER: readonly CompressibleLayer[] = ["l5", "l4", "l6Ext", "l3"];

export function createLayers(
  init: Partial<ContextLayers> & Pick<ContextLayers, "l3">,
): ContextLayers {
  return {
    l1: init.l1 ?? "",
    l3: init.l3,
    mind: init.mind ?? [],
    l4: init.l4 ?? [],
    l5: init.l5 ?? [],
    l6Core: init.l6Core ?? [],
    l6Ext: init.l6Ext ?? [],
  };
}

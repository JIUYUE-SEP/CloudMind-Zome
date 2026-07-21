import type { ChatMessage } from "@mindcloud/shared";

/** L6 工具 schema（Phase 1 不依赖内部结构，token 计数按 JSON 序列化） */
export type ToolSchema = unknown;

/**
 * 上下文分层（设计文档 docs/design/context-pipeline-v2.md 第二节）。
 *
 * 可压缩性决策（不可变更）：
 * - L1（人格）/ L2（@提及提醒）/ L6-core（核心工具）：永不压缩
 * - L5（话题摘要）/ L4（语义检索）/ L6-ext（扩展工具）/ L3（热上下文）：可按降级序列裁剪
 */
export interface ContextLayers {
  /** L1 人格文件内容（mindContext） */
  l1: string;
  /** L2 @提及提醒（mentionDesc） */
  l2?: string;
  /** L3 热上下文（当前场景近期消息），降级时从最旧处截断 */
  l3: ChatMessage[];
  /** L4 语义检索结果（Phase 3 接入；Phase 1 恒空） */
  l4: string[];
  /** L5 话题摘要（Phase 2 接入；Phase 1 恒空） */
  l5: string[];
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
    l2: init.l2,
    l3: init.l3,
    l4: init.l4 ?? [],
    l5: init.l5 ?? [],
    l6Core: init.l6Core ?? [],
    l6Ext: init.l6Ext ?? [],
  };
}

import type { ChatMessage } from "@mindcloud/shared";
import type { ContextLayers } from "./layers.js";

export interface DowngradeStep {
  /** 步骤名（日志/调试/测试断言用） */
  name: string;
  /** 当前 layers 下该步骤是否可执行 */
  applicable(layers: ContextLayers): boolean;
  /** 执行降级（原地修改 layers） */
  apply(layers: ContextLayers): void;
}

/**
 * L3 热上下文截断：保留最新 keep 条。
 * 截断可能切断 assistant(toolCalls) → tool 结果的消息对，孤立的 tool 消息
 * 会让 OpenAI 协议报错（tool 消息必须有前置 toolCalls），从头部一并丢弃。
 */
export function truncateHotContext(messages: ChatMessage[], keep: number): ChatMessage[] {
  const sliced = messages.slice(-keep);
  let start = 0;
  while (start < sliced.length && sliced[start].role === "tool") start++;
  return sliced.slice(start);
}

/**
 * 降级步骤序列（设计决策：L5 → L4 → L6-ext → L3，L1/L2/L6-core 永不触碰）。
 * 参考 Python 降级伪代码：每步先判断是否可执行，每轮从序列头部重新扫描。
 *
 * L4/L6-ext 数组约定按相关性/优先级降序排列，裁剪保留前部；
 * L5 话题摘要按时间倒序（最新在前），逐条丢弃最旧的一条。
 */
export function createDowngradeSteps(): DowngradeStep[] {
  return [
    {
      name: "l5:drop-oldest",
      applicable: (l) => l.l5.length > 0,
      apply: (l) => {
        l.l5 = l.l5.slice(0, -1);
      },
    },
    {
      name: "l4:keep-10",
      applicable: (l) => l.l4.length > 10,
      apply: (l) => {
        l.l4 = l.l4.slice(0, 10);
      },
    },
    {
      name: "l4:keep-5",
      applicable: (l) => l.l4.length > 5,
      apply: (l) => {
        l.l4 = l.l4.slice(0, 5);
      },
    },
    {
      name: "l4:keep-3",
      applicable: (l) => l.l4.length > 3,
      apply: (l) => {
        l.l4 = l.l4.slice(0, 3);
      },
    },
    {
      name: "l4:drop",
      applicable: (l) => l.l4.length > 0,
      apply: (l) => {
        l.l4 = [];
      },
    },
    {
      name: "l6ext:halve",
      applicable: (l) => l.l6Ext.length > 1,
      apply: (l) => {
        l.l6Ext = l.l6Ext.slice(0, Math.ceil(l.l6Ext.length / 2));
      },
    },
    {
      name: "l6ext:drop",
      applicable: (l) => l.l6Ext.length > 0,
      apply: (l) => {
        l.l6Ext = [];
      },
    },
    {
      name: "l3:keep-15",
      applicable: (l) => l.l3.length > 20,
      apply: (l) => {
        l.l3 = truncateHotContext(l.l3, 15);
      },
    },
    {
      name: "l3:keep-10",
      applicable: (l) => l.l3.length > 15,
      apply: (l) => {
        l.l3 = truncateHotContext(l.l3, 10);
      },
    },
    {
      name: "l3:keep-5",
      applicable: (l) => l.l3.length > 10,
      apply: (l) => {
        l.l3 = truncateHotContext(l.l3, 5);
      },
    },
  ];
}

const orderedSteps = createDowngradeSteps();

/**
 * 从序列头部扫描第一个可执行的降级步骤（与 Python if/elif 链语义一致）；
 * 所有层都不可再降时返回 undefined（调用方走兜底）。
 * 数组顺序即 DOWNGRADE_ORDER（layers.ts）声明的 L5 → L4 → L6-ext → L3。
 */
export function selectNextStep(layers: ContextLayers): DowngradeStep | undefined {
  return orderedSteps.find((s) => s.applicable(layers));
}

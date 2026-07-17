import { get_encoding, type Tiktoken } from "@dqbd/tiktoken";
import type { ChatMessage } from "@mindcloud/shared";

export interface TokenCounter {
  countText(text: string): number;
  countMessages(messages: ChatMessage[]): number;
  countTools(tools: unknown[]): number;
}

/**
 * 基于 tiktoken（cl100k_base）的准确 token 计数，替代"字符数/4"的粗估。
 * 引擎对接的是 OpenAI 兼容协议，模型 tokenizer 各异；按设计文档决策，
 * 统一用 cl100k 计数 + 10% reserveRatio buffer 兜底，宁可保守不可溢出。
 */
export class TiktokenCounter implements TokenCounter {
  /** 每条消息的结构开销（role 分隔等），取 OpenAI cookbook 的惯例值 */
  static readonly MESSAGE_OVERHEAD = 4;

  private encoding: Tiktoken;

  constructor() {
    this.encoding = get_encoding("cl100k_base");
  }

  countText(text: string): number {
    if (!text) return 0;
    return this.encoding.encode(text).length;
  }

  countMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += TiktokenCounter.MESSAGE_OVERHEAD;
      total += this.countText(m.role);
      for (const part of m.content) {
        total += this.countText(part.type === "text" ? part.text : part.think);
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        total += this.countText(JSON.stringify(m.toolCalls));
      }
      if (m.toolCallId) {
        total += this.countText(m.toolCallId);
      }
    }
    return total;
  }

  countTools(tools: unknown[]): number {
    return this.countText(JSON.stringify(tools));
  }
}

// WASM 编码器重复实例化会泄漏内存（tiktoken 需显式 free），全局共享一个单例。
let singleton: TiktokenCounter | undefined;

export function getTokenCounter(): TiktokenCounter {
  if (!singleton) singleton = new TiktokenCounter();
  return singleton;
}

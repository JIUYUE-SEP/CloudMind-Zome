import type { ChatMessage } from "@mindcloud/shared";

/**
 * LLM 历史清洗（P1-6）：修平"半个 turn"与窗口截断造成的协议残缺。
 *
 * step 级落盘后，崩溃/落盘失败可能在热存储留下 assistant 带 toolCalls 但
 * 对应 tool 结果缺失的消息（孤儿 toolCalls）；listBySession 窗口也可能正好
 * 切在 assistant(toolCalls) 与其 tool 结果之间。OpenAI 协议要求每个
 * tool_call 都有后续 tool 消息应答、且 tool 消息必须应答前置 tool_calls——
 * 残缺消息不处理会污染后续所有轮次（provider 直接 400）。
 *
 * 规则（只改 LLM 入参，不动落盘数据与前端展示）：
 * 1. assistant 消息摘除无应答的 toolCallId（全无应答则移除 toolCalls 字段，
 *    正文保留——用户当时看到了流式输出，历史里不该凭空消失）；
 * 2. 没有前置 toolCalls 的 tool 消息一并丢弃（降级截断已有同款处理，
 *    见 downgrade.ts truncateHotContext）。
 */
export function stripUnansweredToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);
  }

  let changed = false;
  const stripped = messages.map((m) => {
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) return m;
    const surviving = m.toolCalls.filter((tc) => answered.has(tc.toolCallId));
    if (surviving.length === m.toolCalls.length) return m;
    changed = true;
    const next: ChatMessage = { ...m };
    if (surviving.length === 0) {
      delete next.toolCalls;
    } else {
      next.toolCalls = surviving;
    }
    return next;
  });

  // tool 消息的前置 toolCalls 必须仍在（未被摘除、且窗口内存在）
  const survivingIds = new Set<string>();
  for (const m of stripped) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) survivingIds.add(tc.toolCallId);
    }
  }
  const result = stripped.filter((m) => {
    const keep = m.role !== "tool" || (m.toolCallId !== undefined && survivingIds.has(m.toolCallId));
    if (!keep) changed = true;
    return keep;
  });

  if (!changed) return messages;
  console.warn("[history] 检测到孤儿 toolCalls/tool 消息（半个 turn 或窗口截断），已清洗后送入 LLM");
  return result;
}

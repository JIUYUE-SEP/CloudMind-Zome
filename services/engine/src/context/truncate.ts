import type { TokenCounter } from "./token-counter.js";

/**
 * 工具结果 token 截断（review M1）。
 * read_file 无上限、run_command 单条可达 1MB，单步即可击穿上下文窗口；
 * 在工具结果 push 到 messages 之前调用，超限时保留头尾、中间以省略标记替代。
 */

/** 单条工具结果的默认 token 上限（无 pipeline 时的兜底值，约为默认预算 72000 的 20%） */
export const DEFAULT_MAX_TOOL_RESULT_TOKENS = 16_000;

/** 工具结果占上下文预算的比例上限（turn 里按 budgetTokens 计算单条上限） */
export const TOOL_RESULT_BUDGET_RATIO = 0.2;

function omittedMarker(omittedTokens: number): string {
  return `\n[...工具结果过长，中间省略约 ${omittedTokens} tokens...]\n`;
}

/** 最大的字符前缀，使其 token 数 ≤ budget（countText 对前缀单调不减，二分查找） */
function prefixWithinBudget(text: string, budget: number, counter: TokenCounter): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (counter.countText(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** 最大的字符后缀，使其 token 数 ≤ budget */
function suffixWithinBudget(text: string, budget: number, counter: TokenCounter): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (counter.countText(text.slice(text.length - mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(text.length - lo);
}

/**
 * 把工具结果文本限制在 maxTokens 以内：未超限原样返回；
 * 超限时保留头尾各一半预算，中间插入省略标记；标记本身都放不下时退化为纯头部截断。
 */
export function truncateToolResultText(
  text: string,
  maxTokens: number,
  counter: TokenCounter,
): string {
  const total = counter.countText(text);
  if (total <= maxTokens) return text;

  const marker = omittedMarker(total - maxTokens);
  const markerTokens = counter.countText(marker);
  const remaining = maxTokens - markerTokens;
  if (remaining <= 0) {
    return prefixWithinBudget(text, maxTokens, counter);
  }
  const head = prefixWithinBudget(text, Math.ceil(remaining / 2), counter);
  const tail = suffixWithinBudget(text, Math.floor(remaining / 2), counter);
  return head + marker + tail;
}

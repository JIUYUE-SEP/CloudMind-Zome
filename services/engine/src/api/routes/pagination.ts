/** 分页参数 clamp（A5）：非法/0/负数回落缺省，超上限封顶，杜绝 NaN/0 引发的全量或空列表 */
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

/** limit clamp：Number() 后非有限/≤0 回落 fallback；上限 MAX_PAGE_LIMIT 封顶 */
export function clampPageLimit(raw: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_PAGE_LIMIT)
    : fallback;
}

/** offset clamp：非有限/负数回落 undefined（与 0 语义等价）；小数向下取整 */
export function clampPageOffset(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

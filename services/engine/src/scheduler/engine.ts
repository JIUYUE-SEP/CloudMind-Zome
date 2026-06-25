import { CronExpressionParser } from "cron-parser";

export function computeNextRun(cron: string, from = new Date()): string | undefined {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: from });
    const next = interval.next().toISOString();
    return next ?? undefined;
  } catch {
    return undefined;
  }
}

export function isDue(nextRunAt: string): boolean {
  return new Date(nextRunAt) <= new Date();
}

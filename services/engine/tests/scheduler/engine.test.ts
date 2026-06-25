import { describe, it, expect } from "vitest";
import { computeNextRun, isDue } from "../../src/scheduler/engine.js";

describe("scheduler engine", () => {
  it("computes next run from cron", () => {
    const next = computeNextRun("0 * * * *", new Date("2024-01-01T12:05:00Z"));
    expect(next).toBe("2024-01-01T13:00:00.000Z");
  });

  it("returns undefined for invalid cron", () => {
    expect(computeNextRun("not a cron")).toBeUndefined();
  });

  it("detects due task", () => {
    expect(isDue(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isDue(new Date(Date.now() + 60000).toISOString())).toBe(false);
  });
});

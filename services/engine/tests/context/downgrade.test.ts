import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { createLayers } from "../../src/context/layers.js";
import {
  createDowngradeSteps,
  selectNextStep,
  truncateHotContext,
} from "../../src/context/downgrade.js";

function msgs(n: number, role: ChatMessage["role"] = "user"): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role,
    content: [{ type: "text" as const, text: `msg ${i}` }],
    createdAt: "2026-07-17T00:00:00Z",
  }));
}

function strings(n: number, prefix = "s"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe("downgrade 单步行为", () => {
  it("L5 多条时合并为一条", () => {
    const layers = createLayers({ l3: [], l5: strings(3, "话题") });
    const step = createDowngradeSteps().find((s) => s.name === "l5:merge")!;
    expect(step.applicable(layers)).toBe(true);
    step.apply(layers);
    expect(layers.l5).toHaveLength(1);
    expect(layers.l5[0]).toContain("话题0");
    expect(layers.l5[0]).toContain("话题2");
  });

  it("L5 仅剩一条时丢弃", () => {
    const layers = createLayers({ l3: [], l5: strings(1) });
    const steps = createDowngradeSteps();
    expect(steps.find((s) => s.name === "l5:merge")!.applicable(layers)).toBe(false);
    const drop = steps.find((s) => s.name === "l5:drop")!;
    expect(drop.applicable(layers)).toBe(true);
    drop.apply(layers);
    expect(layers.l5).toEqual([]);
  });

  it("L4 逐级减少：>10 → 10，>5 → 5，>3 → 3，最后丢弃", () => {
    const layers = createLayers({ l3: [], l4: strings(12) });
    const steps = createDowngradeSteps();
    const byName = (n: string) => steps.find((s) => s.name === n)!;

    expect(byName("l4:keep-10").applicable(layers)).toBe(true);
    byName("l4:keep-10").apply(layers);
    expect(layers.l4).toHaveLength(10);

    expect(byName("l4:keep-5").applicable(layers)).toBe(true);
    byName("l4:keep-5").apply(layers);
    expect(layers.l4).toHaveLength(5);

    expect(byName("l4:keep-3").applicable(layers)).toBe(true);
    byName("l4:keep-3").apply(layers);
    expect(layers.l4).toHaveLength(3);

    expect(byName("l4:drop").applicable(layers)).toBe(true);
    byName("l4:drop").apply(layers);
    expect(layers.l4).toEqual([]);
  });

  it("L4 保留的是排序靠前的（相关性高的）条目", () => {
    const layers = createLayers({ l3: [], l4: strings(8) });
    createDowngradeSteps().find((s) => s.name === "l4:keep-5")!.apply(layers);
    expect(layers.l4).toEqual(strings(5));
  });

  it("L6-ext 先减半再丢弃", () => {
    const layers = createLayers({ l3: [], l6Ext: strings(6, "tool") });
    const steps = createDowngradeSteps();
    const halve = steps.find((s) => s.name === "l6ext:halve")!;
    expect(halve.applicable(layers)).toBe(true);
    halve.apply(layers);
    expect(layers.l6Ext).toHaveLength(3);
    halve.apply(layers);
    expect(layers.l6Ext).toHaveLength(2);

    const drop = steps.find((s) => s.name === "l6ext:drop")!;
    expect(drop.applicable(layers)).toBe(true);
    drop.apply(layers);
    expect(layers.l6Ext).toEqual([]);
  });

  it("L3 逐级截断：>20 → 15，>15 → 10，>10 → 5，保留最新", () => {
    const steps = createDowngradeSteps();
    const byName = (n: string) => steps.find((s) => s.name === n)!;

    const layers = createLayers({ l3: msgs(25) });
    byName("l3:keep-15").apply(layers);
    expect(layers.l3).toHaveLength(15);
    expect(layers.l3[0].id).toBe("m10"); // 保留最新 15 条

    byName("l3:keep-10").apply(layers);
    expect(layers.l3).toHaveLength(10);

    byName("l3:keep-5").apply(layers);
    expect(layers.l3).toHaveLength(5);
    expect(layers.l3.at(-1)!.id).toBe("m24");

    // 10 条以下不再截断
    expect(byName("l3:keep-15").applicable(layers)).toBe(false);
    expect(byName("l3:keep-10").applicable(layers)).toBe(false);
    expect(byName("l3:keep-5").applicable(layers)).toBe(false);
  });

  it("L3 截断丢弃孤立的 tool 消息（前置 assistant toolCalls 已被截掉）", () => {
    const all: ChatMessage[] = [
      ...msgs(8),
      { id: "t1", role: "tool", content: [{ type: "text", text: "result" }], toolCallId: "tc1", createdAt: "2026-07-17T00:00:00Z" },
      ...msgs(4),
    ];
    const truncated = truncateHotContext(all, 5);
    // 保留最新 5 条：t1 + 4 条 user；t1 的 assistant 已被截掉，t1 成孤立 tool 消息
    expect(truncated).toHaveLength(4);
    expect(truncated.every((m) => m.role !== "tool")).toBe(true);
  });

  it("永不压缩层不被任何步骤修改", () => {
    const l6Core = [{ name: "read_file" }];
    const layers = createLayers({
      l1: "人格",
      l1_5: "群聊指令",
      l2: "@提醒",
      l3: msgs(30),
      l4: strings(12),
      l5: strings(3),
      l6Core,
      l6Ext: strings(4, "tool"),
    });
    for (;;) {
      const step = selectNextStep(layers);
      if (!step) break;
      step.apply(layers);
    }
    expect(layers.l1).toBe("人格");
    expect(layers.l1_5).toBe("群聊指令");
    expect(layers.l2).toBe("@提醒");
    expect(layers.l6Core).toBe(l6Core);
  });
});

describe("downgrade 顺序（L5 → L4 → L6-ext → L3）", () => {
  it("selectNextStep 重复执行严格按设计顺序降级", () => {
    const layers = createLayers({
      l3: msgs(25),
      l4: strings(12),
      l5: strings(2),
      l6Ext: strings(4, "tool"),
    });
    const sequence: string[] = [];
    for (;;) {
      const step = selectNextStep(layers);
      if (!step) break;
      sequence.push(step.name);
      step.apply(layers);
    }
    expect(sequence).toEqual([
      "l5:merge",
      "l5:drop",
      "l4:keep-10",
      "l4:keep-5",
      "l4:keep-3",
      "l4:drop",
      "l6ext:halve",
      "l6ext:halve",
      "l6ext:drop",
      "l3:keep-15",
      // 截到 15 条后 >15 不成立、>10 成立，故直接进 keep-5
      "l3:keep-5",
    ]);
  });

  it("所有层都不可再降时返回 undefined（兜底）", () => {
    const layers = createLayers({ l3: msgs(5) });
    expect(selectNextStep(layers)).toBeUndefined();
  });
});

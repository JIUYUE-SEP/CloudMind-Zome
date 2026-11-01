import { describe, it, expect } from "vitest";
import type { LLMEvent, LLMProvider } from "../../src/provider/types.js";
import type { TurnHeartbeat } from "../../src/core/agent-worker.js";
import { judgeTurnProgress, buildJudgeMessage } from "../../src/plugins/watchdog/judge.js";

/**
 * 语义审查（P4）判定层。
 *
 * 核心纪律是「判不出来就放行」——看护误杀的代价（用户丢了正在做的活）
 * 远高于漏判（多等一轮）。所以下面有一半用例是在验证兜底方向。
 */

function heartbeat(overrides: Partial<TurnHeartbeat> = {}): TurnHeartbeat {
  const now = Date.now();
  return {
    startedAt: now - 400_000,
    lastActivityAt: now - 300_000,
    stepCount: 7,
    trace: {
      goal: "把 src/parser.ts 里的日期解析改成支持 ISO 8601",
      steps: [
        "助手调用 [read_file]：读 src/parser.ts",
        "工具结果：export function parseDate(input: string) { ... }",
        "助手调用 [edit_file]：替换正则",
        "工具结果：oldString not found",
      ],
    },
    ...overrides,
  };
}

/** 固定回复的 provider */
function replyProvider(reply: string): LLMProvider {
  return {
    name: "mock",
    supportsModel: () => true,
    async *chat(): AsyncIterable<LLMEvent> {
      yield { type: "text.delta", delta: reply };
      yield { type: "step.end" };
    },
  };
}

describe("plugins/watchdog/judge（P4）", () => {
  it("输出 PROGRESSING → progressing", async () => {
    const verdict = await judgeTurnProgress(replyProvider("PROGRESSING"), "m", heartbeat(), 300_000);
    expect(verdict).toBe("progressing");
  });

  it("输出 STUCK → stuck", async () => {
    const verdict = await judgeTurnProgress(replyProvider("STUCK"), "m", heartbeat(), 300_000);
    expect(verdict).toBe("stuck");
  });

  it("带解释的 STUCK 也能认出来（模型常加一句理由）", async () => {
    const verdict = await judgeTurnProgress(
      replyProvider("STUCK\n反复用同样的 oldString 调 edit_file，每次都失败，没有换思路。"),
      "m",
      heartbeat(),
      300_000,
    );
    expect(verdict).toBe("stuck");
  });

  it("同时出现两个词时取先出现的：那是模型的结论，后面是复述", async () => {
    const verdict = await judgeTurnProgress(
      replyProvider("STUCK（不是 PROGRESSING，因为没有新结果）"),
      "m",
      heartbeat(),
      300_000,
    );
    expect(verdict).toBe("stuck");
  });

  it("输出无法解析 → 放行（宁可多等一轮，不误杀）", async () => {
    const verdict = await judgeTurnProgress(replyProvider("我不确定，看起来还行？"), "m", heartbeat(), 300_000);
    expect(verdict).toBe("progressing");
  });

  it("空输出 → 放行", async () => {
    const verdict = await judgeTurnProgress(replyProvider(""), "m", heartbeat(), 300_000);
    expect(verdict).toBe("progressing");
  });

  it("调用抛错 → 放行（裁判自己失败不牵连被看护的回合）", async () => {
    const failing: LLMProvider = {
      name: "mock",
      supportsModel: () => true,
      async *chat(): AsyncIterable<LLMEvent> {
        throw new Error("provider down");
      },
    };
    const verdict = await judgeTurnProgress(failing, "m", heartbeat(), 300_000);
    expect(verdict).toBe("progressing");
  });

  it("超时 → 放行（挂起的流不能把回合判死）", async () => {
    const hanging: LLMProvider = {
      name: "mock",
      supportsModel: () => true,
      async *chat(): AsyncIterable<LLMEvent> {
        await new Promise<void>(() => {
          /* 永不返回 */
        });
      },
    };
    const verdict = await judgeTurnProgress(hanging, "m", heartbeat(), 300_000, 50);
    expect(verdict).toBe("progressing");
  });

  it("prompt 带上目标、动作轨迹、停滞时长与步数——判据必须完整", () => {
    const message = buildJudgeMessage(heartbeat(), 300_000);
    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    expect(text).toContain("把 src/parser.ts 里的日期解析改成支持 ISO 8601");
    expect(text).toContain("助手调用 [edit_file]");
    expect(text).toContain("oldString not found");
    expect(text).toContain("300 秒");
    expect(text).toContain("已完成步数：7");
    // 防注入声明必须在场：agent 跑的任务里可能夹带祈使句
    expect(text).toContain("防注入");
  });

  it("prompt 明确「慢不算问题」：否则模型会把长任务一律判 STUCK", () => {
    const text = buildJudgeMessage(heartbeat(), 300_000)
      .content.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("慢不算问题");
    expect(text).toContain("不要因为");
  });

  it("无轨迹时 prompt 如实说明，不编造动作", () => {
    const text = buildJudgeMessage(heartbeat({ trace: undefined }), 300_000)
      .content.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("暂无可读的动作记录");
    expect(text).toContain("（未记录）");
  });
});

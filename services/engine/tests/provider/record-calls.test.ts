import { describe, it, expect, vi, afterEach } from "vitest";
import { withLLMCallRecording, type LLMCallSink } from "../../src/provider/record-calls.js";
import type { LLMProvider, LLMEvent } from "../../src/provider/types.js";
import type { LLMCallRecord } from "../../src/memory/repositories/types.js";
import { logger } from "../../src/logger.js";

function makeProvider(events: LLMEvent[], opts?: { throwAfter?: boolean; name?: string }): LLMProvider {
  return {
    name: opts?.name ?? "fake",
    supportsModel: () => true,
    async *chat(): AsyncIterable<LLMEvent> {
      for (const e of events) yield e;
      if (opts?.throwAfter) throw new Error("provider down");
    },
  };
}

function makeSink(impl?: LLMCallSink["append"]): { sink: LLMCallSink; records: LLMCallRecord[] } {
  const records: LLMCallRecord[] = [];
  return {
    records,
    sink: {
      append: impl ?? (async (r) => void records.push(r)),
    },
  };
}

async function drain(provider: LLMProvider): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const e of provider.chat({ model: "mock-x", messages: [] })) out.push(e);
  return out;
}

describe("withLLMCallRecording（P4-5）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("正常调用：记录 model/agent/耗时/status=ok，usage 透传为真实 token 数", async () => {
    const { sink, records } = makeSink();
    const provider = withLLMCallRecording(
      makeProvider(
        [
          { type: "text.delta", delta: "hello" },
          { type: "step.end", finishReason: "stop", usage: { promptTokens: 123, completionTokens: 45 } },
        ],
        { name: "openai" },
      ),
      sink,
      "agent-1",
    );

    const events = await drain(provider);
    // 事件原样透传
    expect(events.map((e) => e.type)).toEqual(["text.delta", "step.end"]);

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.agentId).toBe("agent-1");
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("mock-x");
    expect(r.status).toBe("ok");
    expect(r.promptTokens).toBe(123);
    expect(r.completionTokens).toBe(45);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.createdAt).toBeTruthy();
  });

  it("provider 无 usage（流式拿不到）：tokens 记 0，不硬凑", async () => {
    const { sink, records } = makeSink();
    const provider = withLLMCallRecording(
      makeProvider([{ type: "step.end", finishReason: "stop" }]),
      sink,
      "agent-1",
    );
    await drain(provider);
    expect(records[0]!.promptTokens).toBe(0);
    expect(records[0]!.completionTokens).toBe(0);
  });

  it("调用抛错：记录 status=error 与错误信息，异常原样上抛", async () => {
    const { sink, records } = makeSink();
    const provider = withLLMCallRecording(
      makeProvider([{ type: "text.delta", delta: "半" }], { throwAfter: true }),
      sink,
      "agent-1",
    );
    await expect(drain(provider)).rejects.toThrow("provider down");
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("error");
    expect(records[0]!.error).toContain("provider down");
  });

  it("落档失败不影响 LLM 调用（仅 warn）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { sink } = makeSink(async () => {
      throw new Error("disk full");
    });
    const provider = withLLMCallRecording(
      makeProvider([{ type: "step.end", finishReason: "stop" }]),
      sink,
      "agent-1",
    );
    const events = await drain(provider);
    expect(events).toHaveLength(1);
    // fire-and-forget 的 warn 在微任务后发生
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalledOnce();
  });

  it("真实 LLMCallRepository：llm_calls.jsonl 落档可读回（版本字段随 P1-1 盖章）", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { LLMCallRepository } = await import("../../src/memory/repositories/llm-call.js");
    const { restoreDataDir } = await import("../helpers/env.js");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-call-test-"));
    const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    try {
      const repo = new LLMCallRepository("agent-1");
      const provider = withLLMCallRecording(
        makeProvider(
          [{ type: "step.end", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } }],
          { name: "openai" },
        ),
        repo,
        "agent-1",
      );
      await drain(provider);
      // fire-and-forget 落盘（DocumentStore 按文件串行队列，等队列排空）
      await vi.waitFor(async () => {
        expect((await repo.list()).length).toBe(1);
      });
      const [record] = await repo.list();
      expect(record).toMatchObject({
        agentId: "agent-1",
        provider: "openai",
        model: "mock-x",
        status: "ok",
        promptTokens: 10,
        completionTokens: 5,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    }
  });
});

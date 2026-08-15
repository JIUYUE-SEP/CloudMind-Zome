import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@mindcloud/shared";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { runTurn, type TurnInput } from "../../src/core/react/turn.js";
import { ContextPipeline } from "../../src/context/pipeline.js";
import { ContextPipeline as Pipeline } from "../../src/context/pipeline.js";
import type { LLMEvent, LLMProvider, LLMChatParams } from "../../src/provider/types.js";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";

class CapturingProvider implements LLMProvider {
  name = "capturing";
  capturedParams: LLMChatParams | undefined;
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.capturedParams = params;
    yield { type: "text.delta", delta: "ok" };
    yield { type: "step.end" };
  }
}

function userMsg(id: string, text: string): ChatMessage {
  return { id, role: "user", content: [{ type: "text", text }], createdAt: "2026-07-17T00:00:00Z" };
}

function longHistory(n: number): ChatMessage[] {
  // 每条约 20+ token（真实 tiktoken 计数），30 条 ≈ 600+ token
  return Array.from({ length: n }, (_, i) => userMsg(`h${i}`, `message number ${i} with some extra text to consume tokens`));
}

const toolCtx: TurnInput["toolCtx"] = {
  agentId: "a1",
  workspaceDir: "/tmp",
  tools: new Map(),
  approve: async () => true,
  emit: () => {},
};

describe("ContextPipeline 集成到 runTurn", () => {
  it("每轮经 pipeline 组装：mindContext 注入为首条 system 消息", async () => {
    const provider = new CapturingProvider();
    await runTurn(
      {
        provider,
        model: "mock",
        messages: [userMsg("u1", "hello")],
        tools: [],
        toolCtx,
        contextPipeline: {
          pipeline: new ContextPipeline(),
          input: { agentId: "a1", mindContext: "人格内容", sourceId: "s1" },
        },
      },
      () => {},
    );
    const messages = provider.capturedParams!.messages;
    expect(messages[0].role).toBe("system");
    expect((messages[0].content[0] as { type: "text"; text: string }).text).toBe("人格内容");
    // params.messages 与 runTurn 内部数组同引用，末尾是本轮新生成的 assistant
    expect(messages[1].id).toBe("u1");
  });

  it("超预算时 provider 收到的历史已被降级截断（保留最新）", async () => {
    const provider = new CapturingProvider();
    const history = longHistory(30);
    await runTurn(
      {
        provider,
        model: "mock",
        messages: history,
        tools: [],
        toolCtx,
        contextPipeline: {
          pipeline: new ContextPipeline({ maxContextTokens: 200, reserveRatio: 0 }),
          input: { agentId: "a1", mindContext: "", sourceId: "s1" },
        },
      },
      () => {},
    );
    const received = provider.capturedParams!.messages;
    expect(received.length).toBeLessThan(history.length);
    expect(received.at(-2)!.id).toBe("h29"); // 最新一条历史永远在（末尾是本轮 assistant）
  });

  it("TurnResult.appended 只含本轮新增（不含 pipeline 注入的 system 与历史）", async () => {
    const provider = new CapturingProvider();
    const result = await runTurn(
      {
        provider,
        model: "mock",
        messages: [userMsg("u1", "hello")],
        tools: [],
        toolCtx,
        contextPipeline: {
          pipeline: new ContextPipeline(),
          input: { agentId: "a1", mindContext: "人格", sourceId: "s1" },
        },
      },
      () => {},
    );
    expect(result.appended).toHaveLength(1);
    expect(result.appended[0].role).toBe("assistant");
    expect(result.appended.every((m) => m.role !== "system")).toBe(true);
  });
});

describe("AgentWorker 经 pipeline 组装", () => {
  it("长历史 job 在超小预算下被截断后再发给 provider", async () => {
    const provider = new CapturingProvider();
    const appended: ChatMessage[] = [];
    const worker = new AgentWorker({
      mind: mindService,
      agentId: "a1",
      model: "mock",
      provider,
      tools: [],
      workspaceDir: "/tmp",
      messageRepository: {
        append: async (m: ChatMessage & { sessionId: string }) => {
          appended.push(m);
        },
        listBySession: async () => [],
        getByIds: async () => [],
      } as unknown as IMessageRepository,
      approve: async () => true,
      contextPipeline: new Pipeline({ maxContextTokens: 200, reserveRatio: 0 }),
    });

    const history = longHistory(30);
    await new Promise<void>((resolve) => {
      worker.enqueue({
        id: "j1",
        messages: history,
        onEvent: () => {},
        onDone: () => resolve(),
      });
    });

    const received = provider.capturedParams!.messages;
    expect(received.length).toBeLessThan(history.length);
    expect(received.at(-2)!.id).toBe("h29");
    // 持久化不受截断影响：只含本轮 assistant 回复
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe("assistant");
  });
});

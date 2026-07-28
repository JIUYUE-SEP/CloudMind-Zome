import { describe, it, expect, vi } from "vitest";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { WorkerRegistry } from "../../src/core/worker-registry.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { LLMProvider, LLMEvent } from "../../src/provider/types.js";
import type { ChatMessage } from "@mindcloud/shared";
import type { IMessageRepository } from "../../src/memory/repositories/types.js";

function userMessage(text: string): ChatMessage {
  return {
    id: `u_${text}`,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2024-01-01",
  };
}

function makeWorker(provider: LLMProvider): AgentWorker {
  return new AgentWorker({
    agentId: "a1",
    model: "mock",
    provider,
    tools: [],
    workspaceDir: "/tmp",
    messageRepository: {
      append: async () => {},
      listBySession: async () => [],
      getByIds: async () => [],
      archiveAndRemove: async () => {},
      getArchivedByIds: async () => [],
    } as IMessageRepository,
    approve: async () => true,
  });
}

/** 首次 chat 阻塞在 gate 上的 provider：模拟在途长 turn */
class GateProvider implements LLMProvider {
  name = "gate";
  private release: (() => void) | undefined;
  private entered!: Promise<void>;
  private markEntered!: () => void;

  constructor() {
    this.entered = new Promise<void>((r) => {
      this.markEntered = r;
    });
  }

  supportsModel() {
    return true;
  }

  waitUntilEntered(): Promise<void> {
    return this.entered;
  }

  open(): void {
    this.release?.();
  }

  async *chat(): AsyncIterable<LLMEvent> {
    this.markEntered();
    await new Promise<void>((r) => {
      this.release = r;
    });
    yield { type: "text.delta", delta: "ok" };
    yield { type: "step.end" };
  }
}

describe("WorkerRegistry 配置变更竞态（P3-6）", () => {
  it("retire：排队 job 显式 settle（subagent 前台不挂起）+ 终帧，在途 job 正常跑完", async () => {
    const provider = new GateProvider();
    const worker = makeWorker(provider);
    const registry = new WorkerRegistry();
    await registry.getOrCreate("a1", async () => worker);

    // j1 在途（卡在 gate），j2 排队
    const onDone1 = vi.fn();
    worker.enqueue({ id: "j1", messages: [userMessage("first")], onEvent: () => {}, onDone: onDone1 });
    await provider.waitUntilEntered();
    const events2: LLMEvent[] = [];
    const onDone2 = vi.fn();
    worker.enqueue({
      id: "j2",
      messages: [userMessage("second")],
      onEvent: (e) => events2.push(e),
      onDone: onDone2,
    });

    registry.retire("a1");

    // 排队 job 立即 settle：onDone 带退役错误 + turn.end 终帧 + 重发提示
    expect(onDone2).toHaveBeenCalledTimes(1);
    expect(String(onDone2.mock.calls[0][0])).toContain("retired");
    const types2 = events2.map((e) => e.type);
    expect(types2).toContain("turn.end");
    const deltas2 = events2
      .filter((e) => e.type === "text.delta")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas2.some((d) => d.includes("配置已变更"))).toBe(true);

    // 在途 job 打开 gate 后正常跑完（无错误）
    provider.open();
    await vi.waitFor(() => expect(onDone1).toHaveBeenCalledTimes(1));
    expect(onDone1).toHaveBeenCalledWith(undefined);
  });

  it("getOrCreate 在被替换 worker 排空前不新建：两个 turn 不并发，排空后共享同一新 worker", async () => {
    const registry = new WorkerRegistry();
    const provider = new GateProvider();
    const oldWorker = makeWorker(provider);
    await registry.getOrCreate("a1", async () => oldWorker);

    oldWorker.enqueue({ id: "j1", messages: [userMessage("busy")], onEvent: () => {}, onDone: () => {} });
    await provider.waitUntilEntered();
    registry.retire("a1");

    let created = 0;
    const newWorker = makeWorker(new MockLLMProvider());
    const pending = registry.getOrCreate("a1", async () => {
      created++;
      return newWorker;
    });

    // 在途 turn 未跑完：create 未被调用（不并发）
    await new Promise((r) => setTimeout(r, 50));
    expect(created).toBe(0);

    provider.open();
    const resolved = await pending;
    expect(created).toBe(1);
    expect(resolved).toBe(newWorker);

    // 再次解析：直接命中注册表，不重复创建
    const again = await registry.getOrCreate("a1", async () => {
      created++;
      return makeWorker(new MockLLMProvider());
    });
    expect(again).toBe(newWorker);
    expect(created).toBe(1);
  });

  it("create 返回 undefined 时不入表（agent 不存在语义不变）", async () => {
    const registry = new WorkerRegistry();
    const res = await registry.getOrCreate("ghost", async () => undefined);
    expect(res).toBeUndefined();
    // 再次调用仍会尝试创建（未缓存空结果）
    let called = 0;
    await registry.getOrCreate("ghost", async () => {
      called++;
      return undefined;
    });
    expect(called).toBe(1);
  });

  it("退役后经旧引用 enqueue（群聊/scheduler 可达窗口）：立即 settle 不挂起，waitForIdle 正常返回（Major-1）", async () => {
    const provider = new GateProvider();
    const worker = makeWorker(provider);
    const registry = new WorkerRegistry();
    await registry.getOrCreate("a1", async () => worker);

    // 在途 job 卡住时退役
    worker.enqueue({ id: "j1", messages: [userMessage("busy")], onEvent: () => {}, onDone: () => {} });
    await provider.waitUntilEntered();
    registry.retire("a1");

    // 退役后经旧引用入队（retire 前 getAgentWorker 拿到的引用）：
    // 立即 settle，不落死队列
    const events: LLMEvent[] = [];
    const onDone = vi.fn();
    worker.enqueue({
      id: "j-late",
      messages: [userMessage("late")],
      onEvent: (e) => events.push(e),
      onDone,
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(String(onDone.mock.calls[0][0])).toContain("retired");
    expect(events.map((e) => e.type)).toContain("turn.end");

    // 在途 job 完成后 waitForIdle 正常返回（无死队列卡住），注册表 retiring 清除
    provider.open();
    const created: string[] = [];
    const newWorker = await registry.getOrCreate("a1", async () => {
      created.push("x");
      return makeWorker(new MockLLMProvider());
    });
    expect(created).toHaveLength(1);
    expect(newWorker).toBeDefined();
    expect(newWorker!.status).not.toBe("paused");
  });

  it("并发 getOrCreate 共享同一 in-flight create（Major-2：群聊两条消息排空后不双创建）", async () => {
    const registry = new WorkerRegistry();
    let releaseCreate!: (w: AgentWorker) => void;
    let created = 0;
    const slowCreate = async (): Promise<AgentWorker> => {
      created++;
      return new Promise<AgentWorker>((r) => {
        releaseCreate = r;
      });
    };

    const p1 = registry.getOrCreate("a1", slowCreate);
    const p2 = registry.getOrCreate("a1", slowCreate);
    await new Promise((r) => setTimeout(r, 20));
    // 两个并发调用共享同一创建：create 只跑一次
    expect(created).toBe(1);

    const worker = makeWorker(new MockLLMProvider());
    releaseCreate(worker);
    expect(await p1).toBe(worker);
    expect(await p2).toBe(worker);
  });

  it("create 期间的配置变更不丢失：创建完成后补退役（Major-2）", async () => {
    const registry = new WorkerRegistry();
    let releaseCreate!: (w: AgentWorker) => void;
    const staleWorker = makeWorker(new MockLLMProvider());
    const pending = registry.getOrCreate(
      "a1",
      () => new Promise<AgentWorker>((r) => {
        releaseCreate = r;
      }),
    );

    // create 在途（workers 为空）时来配置变更：登记而不是吞掉
    registry.retire("a1");
    releaseCreate(staleWorker);

    const worker = await pending;
    expect(worker).toBe(staleWorker);
    // 创建完成即补退役：旧配置创建的 worker 不提供服务
    expect(worker!.status).toBe("paused");

    // 下一次解析：按新配置重建（补退役的 waitForIdle 队列已空，立即通过）
    const fresh = makeWorker(new MockLLMProvider());
    const resolved = await registry.getOrCreate("a1", async () => fresh);
    expect(resolved).toBe(fresh);
    expect(resolved!.status).not.toBe("paused");
  });
});

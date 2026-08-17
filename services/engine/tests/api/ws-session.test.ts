import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createServer } from "../../src/api/server.js";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import { AgentWorker, type Job } from "../../src/core/agent-worker.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { computeService } from "../../src/plugins/compute/index.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { LLMEvent, LLMProvider } from "../../src/provider/types.js";
import { getAgentDir } from "../../src/config/paths.js";

function mockOf(p: LLMProvider | undefined): MockLLMProvider {
  return p as MockLLMProvider;
}
import type { ApiContext } from "../../src/api/context.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import WebSocket from "ws";
import { restoreDataDir } from "../helpers/env.js";
import { TEST_AUTH_TOKEN } from "../helpers/auth.js";

async function buildSessionWsContext(
  agentIds: string[],
  tools: Tool[] = [],
  providerFor?: (agentId: string) => LLMProvider,
): Promise<{ context: ApiContext; cleanup: () => Promise<void>; sessionId: string; providers: Map<string, LLMProvider> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-session-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  const workers = new Map<string, AgentWorker>();
  const providers = new Map<string, LLMProvider>();
  for (const agentId of agentIds) {
    await agentRepository.save(agentId, {
      id: agentId,
      name: `Agent ${agentId}`,
      persona: "",
      model: "mock",
      skills: [],
      tools: tools.map((t) => t.name),
    });
    const provider = providerFor?.(agentId) ?? new MockLLMProvider();
    providers.set(agentId, provider);
    workers.set(
      agentId,
      new AgentWorker({
        mind: mindService,
        compute: computeService,
        agentId,
        model: "mock",
        provider,
        tools,
        workspaceDir: tmpDir,
        messageRepository: {
          append: async () => {},
          listBySession: async () => [],
          listBySessionWithArchived: async () => [],
          listBySessionPrefix: async () => [],
          getByIds: async () => [],
          archiveAndRemove: async () => {},
          getArchivedByIds: async () => [],
          listArchivedLazy: async function* () {},
        },
        approve: () => true,
      })
    );
  }

  const sessionRepository = new SessionRepository();
  const session = await sessionRepository.create({
    name: "Test Group",
    agentIds,
    type: "group",
  });

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id: string) => new MessageRepository(id),
    getMemoryRepository: (id: string) => new MemoryRepository(id),
    getActionRepository: (id: string) => new ActionRepository(id),
    getLLMCallRepository: (id: string) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository,
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async (id: string) => workers.get(id),
  };

  return {
    context,
    cleanup: async () => {
      agentRepository.dispose();
      // 等所有 worker 收尾（step/turn 边界的话题状态落盘在消息帧之后仍在飞）
      // 再删临时目录，避免 rm 与异步写撞车（ENOTEMPTY）
      const deadline = Date.now() + 5000;
      while ([...workers.values()].some((w) => w.status !== "idle") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      restoreDataDir(originalDataDir);
    },
    sessionId: session.id,
    providers,
  };
}

describe("Session WebSocket API", () => {
  it("routes user message to all agents and receives replies", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1", "a2"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "hello everyone" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        // Each agent emits text.delta + step.end; wait for both agents.
        const stepEnds = messages.filter((m) => (m as { type: string }).type === "step.end");
        if (stepEnds.length >= 2) {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    const agentIds = messages
      .filter((m) => (m as { type: string }).type === "text.delta")
      .map((m) => (m as { agentId: string }).agentId);
    expect(agentIds).toContain("a1");
    expect(agentIds).toContain("a2");

    await app.close();
    await cleanup();
  });

  it("routes user message to mentioned agent only", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1", "a2"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "@a1 private" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        if (messages.length >= 1) {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    const agentIds = messages
      .filter((m) => (m as { type: string }).type === "text.delta")
      .map((m) => (m as { agentId: string }).agentId);
    expect(agentIds).toContain("a1");
    expect(agentIds).not.toContain("a2");

    await app.close();
    await cleanup();
  });

  it("silently ignores unknown control frames instead of erroring", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", async () => {
        // 未知/遗留控制帧（已移除的 session.set_mode、code.file_open）：
        // 应静默忽略，不回错误，也不改动会话
        client.send(JSON.stringify({ type: "session.set_mode", mode: "code", projectId: "legacy" }));
        client.send(JSON.stringify({ type: "code.file_open", path: "src/a.ts" }));
        await new Promise((r) => setTimeout(r, 300));
        // 随后的正常聊天消息仍应被处理
        client.send(JSON.stringify({ text: "hello" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        messages.push(message);
        if (message.type === "step.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.some((m) => (m as { type: string }).type === "error")).toBe(false);
    expect(messages.some((m) => (m as { type: string }).type === "text.delta")).toBe(true);

    await app.close();
    await cleanup();
  });

  it("群聊 remember:true 对 run_command 被引擎拒绝（P2-2 回归）：其他工具 remember 仍生效", async () => {
    // P2-2（功能 M1）：pending 曾存复合键 "agentX:run_command"，isApprovalRememberable
    // 恒通过 → run_command 在群聊可被 remember 免问。修复后裸 toolName 判定：
    // run_command 两次调用都要审批；safe_writer remember 后第二次直接放行。
    const executions: string[] = [];
    const makeDangerous = (name: string): Tool => ({
      name,
      description: `dangerous ${name}`,
      parameters: z.object({}),
      accesses: [],
      requiresApproval: true,
      async execute(): Promise<ToolResult> {
        executions.push(name);
        return { success: true, output: "ran" };
      },
    });

    const { context, cleanup, sessionId, providers } = await buildSessionWsContext(
      ["a1"],
      [makeDangerous("run_command"), makeDangerous("safe_writer")],
    );
    mockOf(providers.get("a1")).setNextToolCalls([{ toolCallId: "tc1", name: "run_command", arguments: {} }]);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const approvalRequests: { approvalId: string; toolName: string }[] = [];
    let turnEnds = 0;
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "round 1" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "tool.approval_request") {
          approvalRequests.push({ approvalId: message.approvalId, toolName: message.toolName });
          // 自发帧客户端：批准并请求本会话免问
          client.send(
            JSON.stringify({ type: "tool.approval", approvalId: message.approvalId, approved: true, remember: true }),
          );
          return;
        }
        if (message.type === "turn.end") {
          turnEnds++;
          const provider = mockOf(providers.get("a1"));
          if (turnEnds === 1) {
            provider.setNextToolCalls([{ toolCallId: "tc2", name: "run_command", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 2" }));
          } else if (turnEnds === 2) {
            provider.setNextToolCalls([{ toolCallId: "tc3", name: "safe_writer", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 3" }));
          } else if (turnEnds === 3) {
            provider.setNextToolCalls([{ toolCallId: "tc4", name: "safe_writer", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 4" }));
          } else {
            client.close();
            resolve();
          }
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 15000);
    });

    // run_command（round 1/2）：remember:true 不被记住，两次都要审批
    expect(approvalRequests.map((r) => r.toolName)).toEqual(["run_command", "run_command", "safe_writer"]);
    // 四次调用都经批准后执行（无免问旁路）
    expect(executions).toEqual(["run_command", "run_command", "safe_writer", "safe_writer"]);

    await app.close();
    await cleanup();
  });

  it("群聊异常路径：出错的 Agent 也收到 turn.end（P3-1），正常 Agent 不受影响", async () => {
    class ThrowProvider implements LLMProvider {
      name = "throw";
      supportsModel() {
        return true;
      }
      async *chat(): AsyncIterable<LLMEvent> {
        throw new Error("provider down");
      }
    }
    const { context, cleanup, sessionId } = await buildSessionWsContext(
      ["a1", "a2"],
      [],
      (id) => (id === "a1" ? new ThrowProvider() : new MockLLMProvider()),
    );

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: { type: string; agentId?: string; delta?: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "hello everyone" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        messages.push(message);
        // a1 的 turn.end 来自 worker catch 补发；a2 正常收尾
        const turnEnds = messages.filter((m) => m.type === "turn.end").map((m) => m.agentId);
        if (turnEnds.includes("a1") && turnEnds.includes("a2")) {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    // a1 有错误文本增量；两个 Agent 的 turn.end 都到达（群聊永锁解除）
    const a1Deltas = messages
      .filter((m) => m.type === "text.delta" && m.agentId === "a1")
      .map((m) => m.delta ?? "");
    expect(a1Deltas.some((d) => d.includes("provider down"))).toBe(true);

    await app.close();
    await cleanup();
  });

  it("P1-8：连发两条消息按 m1→m2 顺序入队（慢 worker 创建不再让 m2 先跑）", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1"]);

    // 模拟 worker 创建 I/O：第一条消息的 getAgentWorker 慢 150ms，
    // 第二条立即返回——无串行 chain 时 m2 会先入队，回复颠倒
    const originalGetAgentWorker = context.getAgentWorker;
    const wrappedWorkers = new Set<AgentWorker>();
    const jobTexts: string[] = [];
    let calls = 0;
    context.getAgentWorker = async (agentId: string) => {
      calls++;
      const worker = await originalGetAgentWorker(agentId);
      if (worker && !wrappedWorkers.has(worker)) {
        wrappedWorkers.add(worker);
        const originalEnqueue = worker.enqueue.bind(worker);
        worker.enqueue = (job: Job) => {
          // 只取触发本条 job 的最后一条用户消息（历史里含先前消息）
          const trigger = [...job.messages].reverse().find((m) => m.role === "user");
          jobTexts.push(
            trigger?.content.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "",
          );
          originalEnqueue(job);
        };
      }
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return worker;
    };

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);
    let turnEnds = 0;
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "m1" }));
        client.send(JSON.stringify({ text: "m2" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "turn.end") {
          turnEnds++;
          if (turnEnds === 2) {
            client.close();
            resolve();
          }
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    expect(jobTexts).toEqual(["m1", "m2"]);
    expect(calls).toBe(2);

    await app.close();
    await cleanup();
  });

  it("M30：持久化跳过已删 agent，不重建幽灵数据目录", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1", "ghost"]);
    // 删除 ghost：session.agentIds 仍引用它（真实场景=删 agent 不会改写历史 session）
    await context.agentRepository.delete("ghost");
    const ghostDir = getAgentDir("ghost");
    await expect(fs.access(ghostDir)).rejects.toThrow();
    // 已删 agent 不再有 worker（与 bootstrap 注册表行为一致）
    const origGet = context.getAgentWorker;
    context.getAgentWorker = async (id: string) => (id === "ghost" ? undefined : origGet(id));

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "hello everyone" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "step.end" && message.agentId === "a1") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    // a1 仓库正常落库；已删 ghost 的目录未被 append 重建
    const a1Messages = await context.getMessageRepository("a1").listBySession(sessionId);
    expect(a1Messages.some((m) => m.role === "user")).toBe(true);
    await expect(fs.access(ghostDir)).rejects.toThrow();

    await app.close();
    await cleanup();
  });

  it("M30：重复 @mention 去重——同一 agent 只入队一次", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1", "a2"]);
    const worker = (await context.getAgentWorker("a1"))!;
    let enqueueCount = 0;
    const origEnqueue = worker.enqueue.bind(worker);
    worker.enqueue = (job: Job) => {
      enqueueCount++;
      origEnqueue(job);
    };

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);
    const repliedAgents: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "@a1 @a1 hello" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "step.end") {
          repliedAgents.push(message.agentId);
          // 等一拍再收尾：去重失效会再入队一次并产生第二个 turn
          setTimeout(() => {
            client.close();
            resolve();
          }, 300);
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(enqueueCount).toBe(1);
    expect(repliedAgents).toEqual(["a1"]);

    await app.close();
    await cleanup();
  });

  it("M30：ready 后待处理消息深度超限 → 报错断连（与 ready 前缓冲同口径）", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1"]);
    // warmup 后 getAgentWorker 悬挂：消息处理永不完成，chain 深度只增不减
    const origGet = context.getAgentWorker;
    let hanging = false;
    context.getAgentWorker = async (id: string) => {
      if (hanging) return new Promise(() => {});
      return origGet(id);
    };

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);
    let sawOverflow = false;
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "warmup" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "turn.end") {
          // warmup 完成 = ready 且 chain 已排空；此后处理悬挂，深度累积
          hanging = true;
          for (let i = 0; i < 101; i++) {
            client.send(JSON.stringify({ text: `flood ${i}` }));
          }
        }
        if (message.type === "error" && message.error === "Too many pending messages") {
          sawOverflow = true;
        }
      });
      client.on("close", () => {
        if (sawOverflow) resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    expect(sawOverflow).toBe(true);
    hanging = false;

    await app.close();
    await cleanup();
  });

});

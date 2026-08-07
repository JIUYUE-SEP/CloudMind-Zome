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
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { LLMEvent, LLMProvider } from "../../src/provider/types.js";

function mockOf(p: LLMProvider | undefined): MockLLMProvider {
  return p as MockLLMProvider;
}
import type { ApiContext } from "../../src/api/context.js";
import { getDataDir } from "../../src/config/paths.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
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

  it("rejects invalid mode", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "session.set_mode", mode: "invalid" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        client.close();
        resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "error", error: "Invalid mode" });

    const session = await context.sessionRepository.get(sessionId);
    expect(session?.mode).toBeUndefined();

    await app.close();
    await cleanup();
  });

  it("rejects invalid project id", async () => {
    const { context, cleanup, sessionId } = await buildSessionWsContext(["a1"]);
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "session.set_mode", mode: "code", projectId: "../escape" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        client.close();
        resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "error", error: "Invalid project id" });

    const projectRoot = path.join(getDataDir(), "projects", "../escape");
    await expect(fs.stat(projectRoot)).rejects.toThrow();

    const session = await context.sessionRepository.get(sessionId);
    expect(session?.mode).toBeUndefined();
    expect(session?.projectId).toBeUndefined();

    await app.close();
    await cleanup();
  });

  it("does not use projectRoot in chat mode even when projectId is set", async () => {
    const capturedRoots: (string | undefined)[] = [];
    const rootCapturingTool: Tool = {
      name: "capture_root",
      description: "captures projectRoot",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute(ctx: ToolContext): Promise<ToolResult> {
        capturedRoots.push(ctx.projectRoot);
        return { success: true, output: "captured" };
      },
    };

    const { context, cleanup, sessionId, providers } = await buildSessionWsContext(["a1"], [rootCapturingTool]);
    mockOf(providers.get("a1")).setNextToolCalls([{ toolCallId: "tc-1", name: "capture_root", arguments: {} }]);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "session.set_mode", mode: "chat", projectId: "proj-chat" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        messages.push(message);
        if (message.type === "session.mode_changed") {
          client.send(JSON.stringify({ text: "run tool" }));
        }
        if (message.type === "step.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.some((m) => (m as { type: string }).type === "session.mode_changed")).toBe(true);
    expect(capturedRoots).toContain(undefined);

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
        // 未知控制帧（前端协议超前/遗留帧）：应静默忽略，不回错误
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

  it("sets code mode and injects projectRoot into tool context", async () => {
    const capturedJobs: Job[] = [];
    const capturedRoots: (string | undefined)[] = [];
    const rootCapturingTool: Tool = {
      name: "capture_root",
      description: "captures projectRoot",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute(ctx: ToolContext): Promise<ToolResult> {
        capturedRoots.push(ctx.projectRoot);
        return { success: true, output: "captured" };
      },
    };

    const { context, cleanup, sessionId, providers } = await buildSessionWsContext(["a1"], [rootCapturingTool]);
    mockOf(providers.get("a1")).setNextToolCalls([{ toolCallId: "tc-1", name: "capture_root", arguments: {} }]);

    // Wrap worker to capture enqueued jobs
    const originalGetAgentWorker = context.getAgentWorker;
    context.getAgentWorker = async (id: string) => {
      const worker = await originalGetAgentWorker(id);
      if (!worker) return worker;
      const originalEnqueue = worker.enqueue.bind(worker);
      worker.enqueue = (job: Job) => {
        capturedJobs.push(job);
        return originalEnqueue(job);
      };
      return worker;
    };

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "session.set_mode", mode: "code", projectId: "test-project" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        messages.push(message);
        if (message.type === "session.mode_changed") {
          client.send(JSON.stringify({ text: "run tool" }));
        }
        if (message.type === "step.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.some((m) => (m as { type: string }).type === "session.mode_changed")).toBe(true);

    const session = await context.sessionRepository.get(sessionId);
    expect(session?.mode).toBe("code");
    expect(session?.projectId).toBe("test-project");

    const expectedProjectRoot = path.join(getDataDir(), "projects", "test-project");
    await expect(fs.stat(expectedProjectRoot)).resolves.toBeDefined();

    expect(capturedJobs.length).toBeGreaterThan(0);
    expect(capturedJobs.some((job) => job.mode === "code" && job.projectRoot === expectedProjectRoot)).toBe(true);
    expect(capturedRoots).toContain(expectedProjectRoot);

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
});

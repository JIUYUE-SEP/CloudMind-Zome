import { describe, it, expect, vi } from "vitest";
import { logger } from "../../src/logger.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../src/api/server.js";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { HandoffManager } from "../../src/handoff/manager.js";
import { HandoffStateStore } from "../../src/handoff/state.js";
import { HandoffLoopRegistry } from "../../src/handoff/registry.js";
import { HandoffConnectionBridge } from "../../src/plugins/handoff/connection-bridge.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { computeService } from "../../src/plugins/compute/index.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { LLMChatParams, LLMEvent } from "../../src/provider/types.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import { McpClientManager } from "../../src/tools/mcp/index.js";
import { z } from "zod";
import type { ApiContext } from "../../src/api/context.js";
import WebSocket from "ws";
import { restoreDataDir } from "../helpers/env.js";
import { TEST_AUTH_TOKEN } from "../helpers/auth.js";

async function buildWsContext(
  agentId: string,
  tools: Tool[] = [],
  provider: MockLLMProvider = new MockLLMProvider(),
  mcpManager?: McpClientManager,
): Promise<{ context: ApiContext; cleanup: () => Promise<void>; provider: MockLLMProvider }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const agentRepository = new AgentRepository();
  await agentRepository.save(agentId, {
    id: agentId,
    name: "Test",
    persona: "",
    model: "mock",
    skills: [],
    tools: [],
  });

  const providerInstance = provider;
  const worker = new AgentWorker({
      mind: mindService,
      compute: computeService,
    agentId,
    model: "mock",
    provider: providerInstance,
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
  });

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id: string) => new MessageRepository(id),
    getMemoryRepository: (id: string) => new MemoryRepository(id),
    getActionRepository: (id: string) => new ActionRepository(id),
    getLLMCallRepository: (id: string) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async (id: string) => (id === agentId ? worker : undefined),
    ...(mcpManager ? { mcpManager } : {}),
  };

  return {
    context,
    cleanup: async () => {
      agentRepository.dispose();
      // 等 worker 收尾（step/turn 边界的话题状态落盘在消息帧之后仍在飞）
      // 再删临时目录，避免 rm 与异步写撞车（ENOTEMPTY）。
      // 只在 busy 时等待：paused 是合法终态（P3-5 测试会故意 pause 旧 worker）
      const deadline = Date.now() + 5000;
      while (worker.status === "busy" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      restoreDataDir(originalDataDir);
    },
    provider,
  };
}

describe("WebSocket API", () => {
  it("connects and receives assistant text", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "hello" }));
      });
      client.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
        if (messages.length >= 2) {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => (m as { type: string }).type === "text.delta")).toBe(true);
    await app.close();
    await cleanup();
  });

  it("silently ignores unknown control frames instead of erroring", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

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

  it("停止生成：turn.cancel 中断在途回合，终帧带 aborted.reason=user 且不刷错误", async () => {
    // 慢 provider：先吐一个 delta 让前端进入流式态，然后挂起，直到收到
    // 取消信号才结束——模拟「用户看着字一个个出来，中途点停止」。
    // signal 若没从 handler 贯通下来，这里会永久挂起，测试超时即失败。
    class HangingProvider extends MockLLMProvider {
      override async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
        yield { type: "text.delta", delta: "生成中" };
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(new Error("aborted"));
          if (params.signal?.aborted) {
            fail();
            return;
          }
          params.signal?.addEventListener("abort", fail, { once: true });
        });
      }
    }

    const { context, cleanup } = await buildWsContext("agent-ws", [], new HangingProvider());
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

    const messages: Array<{ type: string; aborted?: { reason?: string } }> = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "写一篇长文" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data)) as { type: string; aborted?: { reason?: string } };
        messages.push(message);
        // 收到首个 delta 说明回合已经开始跑，此刻才点「停止」
        if (message.type === "text.delta") {
          client.send(JSON.stringify({ type: "turn.cancel" }));
        }
        if (message.type === "turn.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    const turnEnd = messages.find((m) => m.type === "turn.end");
    expect(turnEnd).toBeDefined();
    // 中断必须可归因：前端靠这个字段把气泡标成「已中断」而不是「正常说完」
    expect(turnEnd?.aborted?.reason).toBe("user");
    // 用户主动停止是正常操作，不该冒错误气泡
    expect(messages.some((m) => m.type === "error")).toBe(false);
    await app.close();
    await cleanup();
  });

  it("停止生成：无在途回合时 turn.cancel 静默无副作用，后续消息仍正常处理", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

    const messages: Array<{ type: string }> = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", async () => {
        // 空转的停止帧（前端连点、或上一轮刚好自然结束）
        client.send(JSON.stringify({ type: "turn.cancel" }));
        await new Promise((r) => setTimeout(r, 200));
        client.send(JSON.stringify({ text: "hello" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data)) as { type: string };
        messages.push(message);
        if (message.type === "step.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(messages.some((m) => m.type === "error")).toBe(false);
    expect(messages.some((m) => m.type === "text.delta")).toBe(true);
    await app.close();
    await cleanup();
  });

  it("写类工具 remember:true 被引擎拒绝（P2-3）：write_file 每次都批，bash 仍免问", async () => {
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

    const { context, cleanup, provider } = await buildWsContext("agent-ws", [
      makeDangerous("write_file"),
      makeDangerous("bash"),
    ]);
    provider.setNextToolCalls([{ toolCallId: "tc1", name: "write_file", arguments: {} }]);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

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
          client.send(
            JSON.stringify({ type: "tool.approval", approvalId: message.approvalId, approved: true, remember: true }),
          );
          return;
        }
        if (message.type === "turn.end") {
          turnEnds++;
          if (turnEnds === 1) {
            provider.setNextToolCalls([{ toolCallId: "tc2", name: "write_file", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 2" }));
          } else if (turnEnds === 2) {
            provider.setNextToolCalls([{ toolCallId: "tc3", name: "bash", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 3" }));
          } else if (turnEnds === 3) {
            provider.setNextToolCalls([{ toolCallId: "tc4", name: "bash", arguments: {} }]);
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

    // write_file（round 1/2）：remember:true 不被记住（P2-3 收窄），两次都要审批；
    // bash（round 3/4）：remember 生效，第二次免问
    expect(approvalRequests.map((r) => r.toolName)).toEqual(["write_file", "write_file", "bash"]);
    expect(executions).toEqual(["write_file", "write_file", "bash", "bash"]);

    await app.close();
    await cleanup();
  });

  it("MCP 工具（mcp__ 前缀）remember:true 被引擎拒绝：每次都批", async () => {
    const executions: string[] = [];
    const mcpTool: Tool = {
      name: "mcp__demo__delete_file",
      description: "MCP write tool",
      parameters: z.object({}),
      accesses: [],
      requiresApproval: true,
      async execute(): Promise<ToolResult> {
        executions.push("mcp__demo__delete_file");
        return { success: true, output: "ran" };
      },
    };

    const { context, cleanup, provider } = await buildWsContext("agent-ws", [mcpTool]);
    provider.setNextToolCalls([{ toolCallId: "tc1", name: "mcp__demo__delete_file", arguments: {} }]);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

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
          client.send(
            JSON.stringify({ type: "tool.approval", approvalId: message.approvalId, approved: true, remember: true }),
          );
          return;
        }
        if (message.type === "turn.end") {
          turnEnds++;
          if (turnEnds === 1) {
            provider.setNextToolCalls([{ toolCallId: "tc2", name: "mcp__demo__delete_file", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 2" }));
          } else {
            client.close();
            resolve();
          }
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 15000);
    });

    // remember:true 不被记住（mcp__ 前缀一律禁免问），两轮都要审批，两次都真实执行
    expect(approvalRequests.map((r) => r.toolName)).toEqual([
      "mcp__demo__delete_file",
      "mcp__demo__delete_file",
    ]);
    expect(executions).toEqual(["mcp__demo__delete_file", "mcp__demo__delete_file"]);

    await app.close();
    await cleanup();
  });

  it("外部插件工具（ext__ 前缀）remember:true 被引擎拒绝：每次都批（E3）", async () => {
    const executions: string[] = [];
    const extTool: Tool = {
      name: "ext__demo__danger_op",
      description: "external plugin tool",
      parameters: z.object({}),
      accesses: [],
      requiresApproval: true,
      async execute(): Promise<ToolResult> {
        executions.push("ext__demo__danger_op");
        return { success: true, output: "ran" };
      },
    };

    const { context, cleanup, provider } = await buildWsContext("agent-ws", [extTool]);
    provider.setNextToolCalls([{ toolCallId: "tc1", name: "ext__demo__danger_op", arguments: {} }]);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

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
          client.send(
            JSON.stringify({ type: "tool.approval", approvalId: message.approvalId, approved: true, remember: true }),
          );
          return;
        }
        if (message.type === "turn.end") {
          turnEnds++;
          if (turnEnds === 1) {
            provider.setNextToolCalls([{ toolCallId: "tc2", name: "ext__demo__danger_op", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 2" }));
          } else {
            client.close();
            resolve();
          }
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 15000);
    });

    // remember:true 不被记住（ext__ 前缀与 mcp__ 同待遇禁免问，且无 override 通道），
    // 两轮都要审批，两次都真实执行
    expect(approvalRequests.map((r) => r.toolName)).toEqual([
      "ext__demo__danger_op",
      "ext__demo__danger_op",
    ]);
    expect(executions).toEqual(["ext__demo__danger_op", "ext__demo__danger_op"]);

    await app.close();
    await cleanup();
  });

  it("MCP 工具 toolOverrides.allowRemember:true 放行 remember：第二轮免问", async () => {
    const executions: string[] = [];
    const mcpTool: Tool = {
      name: "mcp__demo__read_thing",
      description: "MCP tool with local trust override",
      parameters: z.object({}),
      accesses: [],
      requiresApproval: true,
      async execute(): Promise<ToolResult> {
        executions.push("mcp__demo__read_thing");
        return { success: true, output: "ran" };
      },
    };
    // 本地显式信任：server 配置 toolOverrides 放行该限定名的 remember
    const mcpManager = new McpClientManager([
      {
        name: "demo",
        command: "node",
        toolOverrides: { "mcp__demo__read_thing": { allowRemember: true } },
      },
    ]);

    const { context, cleanup, provider } = await buildWsContext(
      "agent-ws",
      [mcpTool],
      new MockLLMProvider(),
      mcpManager,
    );
    provider.setNextToolCalls([{ toolCallId: "tc1", name: "mcp__demo__read_thing", arguments: {} }]);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

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
          client.send(
            JSON.stringify({ type: "tool.approval", approvalId: message.approvalId, approved: true, remember: true }),
          );
          return;
        }
        if (message.type === "turn.end") {
          turnEnds++;
          if (turnEnds === 1) {
            provider.setNextToolCalls([{ toolCallId: "tc2", name: "mcp__demo__read_thing", arguments: {} }]);
            client.send(JSON.stringify({ text: "round 2" }));
          } else {
            client.close();
            resolve();
          }
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 15000);
    });

    // allowRemember:true 放行：remember 生效，第二轮不再审批，两轮都真实执行
    expect(approvalRequests.map((r) => r.toolName)).toEqual(["mcp__demo__read_thing"]);
    expect(executions).toEqual(["mcp__demo__read_thing", "mcp__demo__read_thing"]);

    await app.close();
    await mcpManager.close();
    await cleanup();
  });

  it("配置变更后消息路由到新 worker，不进已 pause 的孤儿（P3-5）", async () => {
    const chatCount = { p1: 0, p2: 0 };
    class CountingMock extends MockLLMProvider {
      constructor(private counter: "p1" | "p2") {
        super();
      }
      override async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
        chatCount[this.counter]++;
        yield* super.chat(params);
      }
    }

    const { context, cleanup } = await buildWsContext("agent-ws", [], new CountingMock("p1"));
    const worker1 = (await context.getAgentWorker("agent-ws"))!;
    const worker2 = new AgentWorker({
      mind: mindService,
      compute: computeService,
      agentId: "agent-ws",
      model: "mock",
      provider: new CountingMock("p2"),
      tools: [],
      workspaceDir: "/tmp",
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
    });
    // 模拟注册表行为：初始指向 worker1；配置变更后 retire 旧 worker 并替换
    //（生产注册表走 worker-registry 的 retire()，pause/resume 公开方法已删除——M2）
    let current: AgentWorker = worker1;
    context.getAgentWorker = async (id: string) => (id === "agent-ws" ? current : undefined);

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

    let turnEnds = 0;
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "first" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "turn.end") {
          turnEnds++;
          if (turnEnds === 1) {
            // 开着聊天页改配置：注册表 retire 旧 worker 并换上新 worker
            worker1.retire();
            current = worker2;
            client.send(JSON.stringify({ text: "second" }));
          } else {
            client.close();
            resolve();
          }
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    // 孤儿 worker 未收到新消息；新 worker 正常处理并回复
    expect(chatCount.p1).toBe(1);
    expect(chatCount.p2).toBe(1);
    expect(worker1.status).toBe("paused");

    await app.close();
    await cleanup();
  });

  it("审批全链路审计日志（P4-3）：请求/批准/免问记入各有结构化日志", async () => {
    const { context, cleanup, provider } = await buildWsContext("agent-ws", [
      {
        name: "write_file",
        description: "dangerous write",
        parameters: z.object({ path: z.string() }),
        accesses: [],
        requiresApproval: true,
        async execute(): Promise<ToolResult> {
          return { success: true, output: "wrote" };
        },
      },
    ]);
    provider.setNextToolCalls([
      { toolCallId: "tc1", name: "write_file", arguments: { path: "docs/a.md" } },
    ]);

    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "go" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "tool.approval_request") {
          client.send(
            JSON.stringify({ type: "tool.approval", approvalId: message.approvalId, approved: true, remember: true }),
          );
        }
        if (message.type === "turn.end") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    // 请求：含 agent/session/approvalId/toolName/参数摘要（path 全文）
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-ws",
        sessionId: "s1",
        toolName: "write_file",
        toolCallId: "tc1",
        args: "path=docs/a.md",
      }),
      "[approval] 请求审批",
    );
    // 批准与免问记入（remember:true 但 write_file 每次必批——P2-3 起是"免问被拒"）
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-ws", toolName: "write_file", approved: true }),
      "[approval] 批准",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-ws", toolName: "write_file" }),
      "[approval] remember 被引擎拒绝（该工具每次必批）",
    );

    info.mockRestore();
    warn.mockRestore();
    await app.close();
    await cleanup();
  });

  it("M31：用户消息持久化失败即中止，不入队（不再答非所问）", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
    // 持久化层整体失败
    context.getMessageRepository = (id: string) => {
      const repo = new MessageRepository(id);
      repo.append = async () => {
        throw new Error("disk full");
      };
      return repo;
    };
    const worker = (await context.getAgentWorker("agent-ws"))!;
    let enqueued = 0;
    const origEnqueue = worker.enqueue.bind(worker);
    worker.enqueue = (job) => {
      enqueued++;
      origEnqueue(job);
    };

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);
    const frames: Array<{ type?: string; error?: string }> = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({ text: "hello" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        frames.push(message);
        if (message.type === "error") {
          client.close();
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    // 错误帧已发，但消息未入队、无 assistant 输出
    expect(frames.some((f) => f.type === "error" && f.error === "Failed to persist message")).toBe(true);
    expect(frames.some((f) => f.type === "text.delta")).toBe(false);
    expect(enqueued).toBe(0);

    await app.close();
    await cleanup();
  });

  it("M30：ready 后待处理消息深度超限 → 报错断连（与 ready 前缓冲同口径）", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
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

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);
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

  it("F11：冷 worker 创建窗口内断连——不 attach 连接桥、不回放缓冲消息", async () => {
    const { context, cleanup } = await buildWsContext("agent-ws");
    const worker = (await context.getAgentWorker("agent-ws"))!;
    let enqueued = 0;
    const origEnqueue = worker.enqueue.bind(worker);
    worker.enqueue = (job) => {
      enqueued++;
      origEnqueue(job);
    };

    // handoff 控制面 + 连接桥（生产同款装配）；spy attachConnection 判僵尸 loop
    //（attach 即 register 进注册表——未 attach 则注册表必然无残留）
    const handoffManager = new HandoffManager({ store: new HandoffStateStore() });
    const handoffLoops = new HandoffLoopRegistry();
    let attachCount = 0;
    context.handoff = {
      manager: handoffManager,
      loops: handoffLoops,
      attachConnection: (deps) => {
        attachCount++;
        return new HandoffConnectionBridge(deps, { manager: handoffManager, loops: handoffLoops });
      },
    };

    // 冷 worker 创建窗口：首个 getAgentWorker 悬挂，直到测试放行
    const origGet = context.getAgentWorker;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCall = true;
    context.getAgentWorker = async (id: string) => {
      if (firstCall) {
        firstCall = false;
        await gate; // 模拟冷 worker 创建 I/O 窗口
      }
      return origGet(id);
    };

    const app = await createServer(context);
    const address = await app.listen({ port: 0 });
    const port = Number(new URL(address).port);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-ws?sessionId=s1`, TEST_AUTH_TOKEN);
    await new Promise<void>((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    // 窗口内：发消息（进 ready 前缓冲）→ 立即断连
    client.send(JSON.stringify({ text: "buffered during cold start" }));
    client.close();
    // 客户端 close 事件落定 = 服务端已收完 Close 帧（TCP 有序），此时服务端
    // socket.readyState 必为 CLOSED——放行 worker 创建后命中 readyState 闸
    await new Promise<void>((resolve) => client.on("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 100));
    release();
    await new Promise((r) => setTimeout(r, 300));

    // 不 attach：僵尸 loop 不进注册表；不回放：缓冲消息不入队到死 socket
    expect(attachCount).toBe(0);
    expect(enqueued).toBe(0);

    await app.close();
    await cleanup();
  });
});

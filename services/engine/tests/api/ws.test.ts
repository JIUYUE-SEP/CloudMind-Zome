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
import { MockLLMProvider } from "../../src/provider/llm.js";
import type { LLMChatParams, LLMEvent } from "../../src/provider/types.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import { z } from "zod";
import type { ApiContext } from "../../src/api/context.js";
import WebSocket from "ws";
import { restoreDataDir } from "../helpers/env.js";
import { TEST_AUTH_TOKEN } from "../helpers/auth.js";

async function buildWsContext(
  agentId: string,
  tools: Tool[] = [],
  provider: MockLLMProvider = new MockLLMProvider(),
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
    agentId,
    model: "mock",
    provider: providerInstance,
    tools,
    workspaceDir: tmpDir,
    messageRepository: {
      append: async () => {},
      listBySession: async () => [],
      getByIds: async () => [],
      archiveAndRemove: async () => {},
      getArchivedByIds: async () => [],
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
      agentId: "agent-ws",
      model: "mock",
      provider: new CountingMock("p2"),
      tools: [],
      workspaceDir: "/tmp",
      messageRepository: {
        append: async () => {},
        listBySession: async () => [],
        getByIds: async () => [],
        archiveAndRemove: async () => {},
        getArchivedByIds: async () => [],
      },
      approve: () => true,
    });
    // 模拟注册表行为：初始指向 worker1；配置变更后 pause 旧 worker 并替换
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
            // 开着聊天页改配置：注册表 pause 旧 worker 并换上新 worker
            worker1.pause();
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
});

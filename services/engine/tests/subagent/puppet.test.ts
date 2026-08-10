/**
 * puppet（傀儡）执行路径测试：
 * ① 前台跑通（基础设定 system + 任务简报 user，蒸馏最后 assistant 文本）；
 * ② 写类工具经 approve 桥接（批准/拒绝两分支 + 无通道 fail-closed）；
 * ③ 记忆即弃（调用方热存储/工作区零新增）；
 * ④ kind=puppet 落盘 agentId=owner；⑤ 后台模式 taskId 可查询；⑥ delegate 回归。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PuppetRunner, buildPuppetSystemPrompt, type PuppetRuntime } from "../../src/subagent/puppet.js";
import {
  CONTEXT_WATERMARK_SUMMARY_HINT,
  HANDOFF_WRITING_GUIDANCE,
} from "../../src/core/react/turn.js";
import type { ConfigRepository } from "../../src/config/repository.js";
import type { PuppetModelDefinition } from "../../src/subagent/puppet-models.js";
import { SubagentDispatcher } from "../../src/subagent/dispatcher.js";
import { BackgroundManager } from "../../src/subagent/background.js";
import { SubagentTaskRepository } from "../../src/subagent/task-repository.js";
import { waitForTerminalTail } from "../helpers/background-tail.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { getAgentDir } from "../../src/config/paths.js";
import { restoreDataDir } from "../helpers/env.js";
import type { LLMChatParams, LLMEvent, LLMProvider } from "../../src/provider/types.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import type { AgentConfig } from "@mindcloud/shared";

const ownerConfig: AgentConfig = { id: "a1", name: "A1", persona: "", model: "mock", skills: [], tools: [] };
const borrowedConfig: AgentConfig = { id: "a2", name: "A2", persona: "", model: "mock", skills: [], tools: [] };

class SpyProvider implements LLMProvider {
  name = "spy";
  captured: LLMChatParams[] = [];
  constructor(private text = "蒸馏结论") {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    // 快照：runTurn 会把 assistant 消息原地追加进同一数组，引用捕获会看到执行后状态
    this.captured.push(structuredClone(params));
    yield { type: "text.delta", delta: this.text };
    yield { type: "step.end" };
  }
}

function makeRuntime(provider: LLMProvider, tools: Tool[] = []): PuppetRuntime {
  return { provider, model: "mock", tools, workspaceDir: os.tmpdir() };
}

function makeDispatcher(opts: {
  provider: LLMProvider;
  tools?: Tool[];
  repository: SubagentTaskRepository;
  runPuppetViaRunner?: boolean;
  getPuppetModel?: (name: string) => Promise<PuppetModelDefinition | undefined>;
}) {
  const runner = new PuppetRunner({
    getRuntime: async (id) => (id === "a1" ? makeRuntime(opts.provider, opts.tools) : undefined),
    getPuppetModel: opts.getPuppetModel,
  });
  const background = new BackgroundManager(
    {
      runAgent: async () => "delegate result",
      runPuppet: (ownerAgentId, taskDescription, runOpts) =>
        runner.run(ownerAgentId, taskDescription, {
          signal: runOpts?.signal,
          puppetModel: runOpts?.puppetModel,
        }),
    },
    opts.repository,
  );
  const dispatcher = new SubagentDispatcher({
    getAgentConfig: async (id) =>
      id === "a1" ? ownerConfig : id === "a2" ? borrowedConfig : undefined,
    runAgent: async () => "delegate result",
    background,
    puppet: runner,
  });
  return { dispatcher, background, runner };
}

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "puppet-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("① puppet 前台跑通", () => {
  it("基础设定 + 任务简报裸跑，蒸馏最后 assistant 文本；忽略 targetAgentId", async () => {
    const provider = new SpyProvider();
    const { dispatcher } = makeDispatcher({
      provider,
      repository: new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl")),
    });

    const result = await dispatcher.dispatch("a1", "ghost-ignored", "do work", {
      mode: "foreground",
      kind: "puppet",
    });

    expect(result).toMatchObject({ output: "蒸馏结论" });
    expect((result as { error?: string }).error).toBeUndefined();

    // messages 恰为 [system 基础设定, user 任务简报]——无 SOUL/无记忆注入
    const messages = provider.captured[0]!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    const systemText = messages[0]!.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(systemText).toContain("a1 的傀儡分机");
    expect(systemText).toContain("你没有记忆");
    expect(messages[1]!.role).toBe("user");
  });

  it("基础设定模板：身份 + 守则 + 能力边界，行数克制", () => {
    const prompt = buildPuppetSystemPrompt("a1");
    expect(prompt.split("\n").length).toBeLessThanOrEqual(10);
    expect(prompt).toContain("可用工具与主人相同");
  });
});

describe("② approve 桥接", () => {
  const writeTool = (executions: string[]): Tool => ({
    name: "write_thing",
    description: "写操作",
    parameters: z.object({}),
    accesses: [],
    requiresApproval: true,
    async execute(): Promise<ToolResult> {
      executions.push("write_thing");
      return { success: true, output: "written" };
    },
  });

  function setupWriteCall(executions: string[], approve?: (name: string) => boolean) {
    const provider = new MockLLMProvider();
    provider.setNextToolCalls([{ toolCallId: "tc1", name: "write_thing", arguments: {} }]);
    const runner = new PuppetRunner({
      getRuntime: async () => makeRuntime(provider, [writeTool(executions)]),
    });
    return { runner, approve };
  }

  it("桥接批准：写类工具真实执行", async () => {
    const executions: string[] = [];
    const { runner } = setupWriteCall(executions);
    const output = await runner.run("a1", "do work", { approve: async () => true });
    expect(executions).toEqual(["write_thing"]);
    expect(output).toBe("Hello from mock");
  });

  it("桥接拒绝：工具不执行，结果为 Approval denied 后继续收尾", async () => {
    const executions: string[] = [];
    const { runner } = setupWriteCall(executions);
    const output = await runner.run("a1", "do work", { approve: async () => false });
    expect(executions).toEqual([]);
    expect(output).toBe("Hello from mock"); // 拒绝后模型继续给最终文本
  });

  it("无审批通道：写类工具 fail-closed 拒绝", async () => {
    const executions: string[] = [];
    const { runner } = setupWriteCall(executions);
    await runner.run("a1", "do work");
    expect(executions).toEqual([]);
  });

  it("puppet 工具上下文带 isPuppet 标记（send_private_message 硬拒的判定依据）", async () => {
    const record: { isPuppet?: boolean } = {};
    const probe: Tool = {
      name: "is_puppet_probe",
      description: "probe",
      parameters: z.object({}),
      accesses: [],
      requiresApproval: false,
      execute: async (ctx) => {
        record.isPuppet = ctx.isPuppet;
        return { success: true, output: "ok" };
      },
    };
    const provider = new MockLLMProvider();
    provider.setNextToolCalls([
      { toolCallId: "tc_p", name: "is_puppet_probe", arguments: {} },
    ]);
    const runner = new PuppetRunner({
      getRuntime: async () => makeRuntime(provider, [probe]),
    });

    await runner.run("a1", "do work");
    expect(record.isPuppet).toBe(true);
  });
});

describe("③ 记忆即弃", () => {
  it("puppet 执行后调用方 agent 目录零新增（热存储/话题/索引文件都不产生）", async () => {
    const provider = new SpyProvider();
    const { dispatcher } = makeDispatcher({
      provider,
      repository: new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl")),
    });

    await dispatcher.dispatch("a1", "ignored", "do work", { mode: "foreground", kind: "puppet" });

    // 不走 AgentWorker：无 onStepAppended（热存储）、无话题压缩、无向量索引钩子
    // （PuppetRuntime 类型上就不携带 memoryIndexer/messageRepository）
    expect(fs.existsSync(getAgentDir("a1"))).toBe(false);
  });
});

describe("④⑤ kind=puppet 后台：落盘 agentId=owner + taskId 可查询", () => {
  it("后台 puppet：record agentId=owner、kind=puppet，任务表可查", async () => {
    const repository = new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl"));
    const provider = new SpyProvider("傀儡后台结果");
    const { dispatcher, background } = makeDispatcher({ provider, repository });

    const taskId = (await dispatcher.dispatch("a1", "ghost-ignored", "bg work", {
      mode: "background",
      kind: "puppet",
    })) as string;
    expect(typeof taskId).toBe("string");

    // 确定性等后台尾巴收完（落盘/notified），替代 1s 轮询预算
    await waitForTerminalTail(background, taskId);
    expect(background.get(taskId)).toMatchObject({
      parentAgentId: "a1",
      agentId: "a1", // 傀儡无独立人形，记 owner
      kind: "puppet",
      output: "傀儡后台结果",
    });

    const record = (await repository.loadAll())[0]!;
    expect(record).toMatchObject({ agentId: "a1", kind: "puppet", outputPreview: "傀儡后台结果" });
  });
});

describe("⑥ delegate 回归", () => {
  it("kind=delegate 走现状路径（借用目标校验 + runAgent），不受 puppet 影响", async () => {
    const repository = new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl"));
    const provider = new SpyProvider();
    const { dispatcher } = makeDispatcher({ provider, repository });

    // 自我借用仍拒绝
    await expect(
      dispatcher.dispatch("a1", "a1", "x", { mode: "foreground", kind: "delegate" }),
    ).rejects.toThrow("cannot dispatch to itself");
    // 未知目标仍拒绝
    await expect(
      dispatcher.dispatch("a1", "ghost", "x", { mode: "foreground", kind: "delegate" }),
    ).rejects.toThrow("Agent ghost not found");
    // delegate 前台走 runAgent（worker 路径），不经 PuppetRunner
    const result = await dispatcher.dispatch("a1", "a2", "do work", { mode: "foreground" });
    expect(result).toMatchObject({ output: "delegate result" });
    expect(provider.captured).toHaveLength(0);
  });
});

describe("⑦ puppet 型号：persona 注入 + 工具窄化", () => {
  function dummyTool(name: string): Tool {
    return {
      name,
      description: name,
      parameters: z.object({}),
      accesses: [],
      requiresApproval: false,
      async execute() {
        return { success: true, output: name };
      },
    };
  }

  const sampleModel = (over: Partial<PuppetModelDefinition> = {}): PuppetModelDefinition => ({
    name: "规划师",
    description: "测试型号",
    personaSnippet: "你是测试特化傀儡。你按测试设定行事。",
    suggestedTools: ["read_file", "write_file"],
    ...over,
  });

  function capturedToolNames(provider: SpyProvider): string[] {
    const params = provider.captured[0]!;
    return (params.tools as { function: { name: string } }[]).map((t) => t.function.name);
  }

  function capturedSystemText(provider: SpyProvider): string {
    const messages = provider.captured[0]!.messages;
    return messages[0]!.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }

  it("型号 persona 片段拼入傀儡基础设定（system 含型号特化块）", async () => {
    const provider = new SpyProvider();
    const runner = new PuppetRunner({
      getRuntime: async () => makeRuntime(provider, [dummyTool("read_file")]),
      getPuppetModel: async () => sampleModel({ suggestedTools: undefined }),
    });

    await runner.run("a1", "do work", { puppetModel: "规划师" });
    const systemText = capturedSystemText(provider);
    expect(systemText).toContain("a1 的傀儡分机");
    expect(systemText).toContain("型号特化：");
    expect(systemText).toContain("你是测试特化傀儡。你按测试设定行事。");
    expect(systemText).toContain("你没有记忆"); // 基础设定守则仍在（不改傀儡制语义）
  });

  it("suggestedTools 窄化：傀儡工具 = 调用方可用 ∩ 型号推荐（交集语义）", async () => {
    const provider = new SpyProvider();
    const runner = new PuppetRunner({
      getRuntime: async () =>
        makeRuntime(provider, [
          dummyTool("read_file"),
          dummyTool("write_file"),
          dummyTool("run_command"),
          dummyTool("web_search"),
        ]),
      getPuppetModel: async () => sampleModel({ suggestedTools: ["read_file", "write_file"] }),
    });

    await runner.run("a1", "do work", { puppetModel: "规划师" });
    expect(capturedToolNames(provider)).toEqual(["read_file", "write_file"]);
  });

  it("suggestedTools 缺省：工具集不窄化（保持调用方全部工具）", async () => {
    const provider = new SpyProvider();
    const runner = new PuppetRunner({
      getRuntime: async () => makeRuntime(provider, [dummyTool("read_file"), dummyTool("bash")]),
      getPuppetModel: async () => sampleModel({ suggestedTools: undefined }),
    });

    await runner.run("a1", "do work", { puppetModel: "规划师" });
    expect(capturedToolNames(provider)).toEqual(["read_file", "bash"]);
  });

  it("suggestedTools 含未知/MCP 名：未知名静默过滤不报错，不扩权", async () => {
    const provider = new SpyProvider();
    const runner = new PuppetRunner({
      getRuntime: async () => makeRuntime(provider, [dummyTool("read_file"), dummyTool("bash")]),
      getPuppetModel: async () =>
        sampleModel({ suggestedTools: ["read_file", "ghost_tool", "mcp__srv__tool"] }),
    });

    await runner.run("a1", "do work", { puppetModel: "规划师" });
    expect(capturedToolNames(provider)).toEqual(["read_file"]);
  });

  it("交集为空：明确报错，不派遣", async () => {
    const runner = new PuppetRunner({
      getRuntime: async () => makeRuntime(new SpyProvider(), [dummyTool("read_file")]),
      getPuppetModel: async () => sampleModel({ suggestedTools: ["web_search"] }),
    });

    await expect(runner.run("a1", "do work", { puppetModel: "规划师" })).rejects.toThrow(
      "交集为空",
    );
  });

  it("型号不存在：明确报错", async () => {
    const runner = new PuppetRunner({
      getRuntime: async () => makeRuntime(new SpyProvider()),
      getPuppetModel: async () => undefined,
    });

    await expect(runner.run("a1", "do work", { puppetModel: "幽灵" })).rejects.toThrow(
      "Puppet model 幽灵 not found",
    );
  });

  it("dispatcher 前台链：puppetModel 贯通 tool→dispatcher→runner，persona 注入 system", async () => {
    const provider = new SpyProvider();
    const repository = new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl"));
    const { dispatcher } = makeDispatcher({
      provider,
      tools: [dummyTool("read_file"), dummyTool("write_file")],
      repository,
      getPuppetModel: async () => sampleModel({ suggestedTools: ["read_file"] }),
    });

    const result = await dispatcher.dispatch("a1", "ignored", "do work", {
      mode: "foreground",
      kind: "puppet",
      puppetModel: "规划师",
    });
    expect(result).toMatchObject({ output: "蒸馏结论" });
    expect(capturedSystemText(provider)).toContain("你是测试特化傀儡。你按测试设定行事。");
    expect(capturedToolNames(provider)).toEqual(["read_file"]);
  });

  it("后台 puppet 带型号：persona 生效、型号名落盘、resume 按名重新解析", async () => {
    const repository = new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl"));
    const provider = new SpyProvider("傀儡型号后台结果");
    const { dispatcher, background } = makeDispatcher({
      provider,
      tools: [dummyTool("read_file"), dummyTool("write_file")],
      repository,
      getPuppetModel: async () => sampleModel({ suggestedTools: ["read_file"] }),
    });

    const taskId = (await dispatcher.dispatch("a1", "ignored", "bg work", {
      mode: "background",
      kind: "puppet",
      puppetModel: "规划师",
    })) as string;
    await waitForTerminalTail(background, taskId);

    expect(provider.captured).toHaveLength(1);
    expect(capturedSystemText(provider)).toContain("你是测试特化傀儡。你按测试设定行事。");
    expect(capturedToolNames(provider)).toEqual(["read_file"]);
    expect(background.get(taskId)?.puppetModel).toBe("规划师");
    const record = (await repository.loadAll())[0]!;
    expect(record.puppetModel).toBe("规划师");

    // resume：同简报重跑，型号名从记录回读并重新解析注入
    const { completion } = background.resume(taskId);
    await completion;
    expect(provider.captured).toHaveLength(2);
    expect(capturedSystemText(provider)).toContain("你是测试特化傀儡。你按测试设定行事。");
  });

  it("重启恢复：新 BackgroundManager load() 从 JSONL 恢复型号名，resume 仍按原型号跑", async () => {
    const repository = new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl"));
    const tools = [dummyTool("read_file"), dummyTool("write_file")];
    const provider1 = new SpyProvider("第一次执行");
    const { dispatcher, background } = makeDispatcher({
      provider: provider1,
      tools,
      repository,
      getPuppetModel: async () => sampleModel({ suggestedTools: ["read_file"] }),
    });

    const taskId = (await dispatcher.dispatch("a1", "ignored", "bg work", {
      mode: "background",
      kind: "puppet",
      puppetModel: "规划师",
    })) as string;
    await waitForTerminalTail(background, taskId);
    expect(provider1.captured).toHaveLength(1);

    // 模拟重启：同一仓库 + 全新 manager/runner（内存索引从 JSONL 重建）
    const provider2 = new SpyProvider("重启后执行");
    const runner2 = new PuppetRunner({
      getRuntime: async () => makeRuntime(provider2, tools),
      getPuppetModel: async () => sampleModel({ suggestedTools: ["read_file"] }),
    });
    const background2 = new BackgroundManager(
      {
        runAgent: async () => "delegate result",
        runPuppet: (ownerAgentId, taskDescription, runOpts) =>
          runner2.run(ownerAgentId, taskDescription, {
            signal: runOpts?.signal,
            puppetModel: runOpts?.puppetModel,
          }),
      },
      repository,
    );
    await background2.load();

    expect(background2.get(taskId)?.puppetModel).toBe("规划师");
    const { completion } = background2.resume(taskId);
    await completion;
    expect(provider2.captured).toHaveLength(1);
    expect(capturedSystemText(provider2)).toContain("你是测试特化傀儡。你按测试设定行事。");
    expect(capturedToolNames(provider2)).toEqual(["read_file"]);
  });

  it("resume 前型号文件被删：明确失败而非静默无型号重跑", async () => {
    const repository = new SubagentTaskRepository(path.join(tmpDir, "tasks.jsonl"));
    let modelAvailable = true;
    const provider = new SpyProvider("原型号结果");
    const { dispatcher, background } = makeDispatcher({
      provider,
      tools: [dummyTool("read_file")],
      repository,
      getPuppetModel: async () =>
        modelAvailable ? sampleModel({ suggestedTools: ["read_file"] }) : undefined,
    });

    const taskId = (await dispatcher.dispatch("a1", "ignored", "bg work", {
      mode: "background",
      kind: "puppet",
      puppetModel: "规划师",
    })) as string;
    await waitForTerminalTail(background, taskId);
    expect(provider.captured).toHaveLength(1);

    modelAvailable = false; // 模拟自定义型号文件被删除
    const { completion } = background.resume(taskId);
    await expect(completion).rejects.toThrow("Puppet model 规划师 not found");
    expect(background.get(taskId)).toMatchObject({ status: "failed", puppetModel: "规划师" });
    expect(String(background.get(taskId)?.error)).toContain("not found");
    expect(provider.captured).toHaveLength(1); // 未静默按无型号重跑
  });
});

describe("⑧ 水位 W 查找链（puppet）", () => {
  it("configRepository 型号表 contextWindow 贯通 runTurn，水位撞顶收尾", async () => {
    class LoopProvider implements LLMProvider {
      name = "loop";
      calls: LLMChatParams[] = [];
      supportsModel() {
        return true;
      }
      async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
        this.calls.push(structuredClone(params));
        const hit = params.messages.some(
          (m) =>
            m.role === "system" &&
            m.content.some((c) => c.type === "text" && c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT)),
        );
        if (hit) {
          yield { type: "text.delta", delta: "傀儡水位收尾" };
        } else {
          yield { type: "tool.call", toolCallId: "tc_1", name: "read_probe", arguments: {} };
        }
        yield { type: "step.end" };
      }
    }
    const readTool: Tool = {
      name: "read_probe",
      description: "probe",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute() {
        return { success: true, output: "ok" };
      },
    };
    const provider = new LoopProvider();
    const configRepository = {
      load: async () => ({
        providers: [
          {
            id: "p1",
            displayName: "P1",
            providerType: "openai",
            baseUrl: "http://localhost",
            models: [{ id: "mock", displayName: "Mock", modelType: "llm", contextWindow: 10 }],
          },
        ],
        settings: {
          memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
        },
      }),
    } as unknown as ConfigRepository;
    const runner = new PuppetRunner({
      getRuntime: async () => ({
        provider,
        model: "mock",
        providerId: "p1",
        configRepository,
        tools: [readTool],
        workspaceDir: os.tmpdir(),
      }),
    });

    const output = await runner.run("a1", "do work");

    // 窗口 10：基础设定 + 简报已远超 90%，首步预检即水位撞顶（不发工具步，
    // 直接兜底总结 + 瘦身写作调用，共 2 次 LLM 调用）
    expect(output).toBe("傀儡水位收尾");
    expect(provider.calls).toHaveLength(2);
    expect(
      provider.calls[0]!.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT)),
      ),
    ).toBe(true);
    expect(
      provider.calls[1]!.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(HANDOFF_WRITING_GUIDANCE)),
      ),
    ).toBe(true);
  });

  it("S3：W 缺档回落 agent maxContextTokens（与 worker 三档一致），型号表查不到也生效", async () => {
    class LoopProvider implements LLMProvider {
      name = "loop";
      calls: LLMChatParams[] = [];
      supportsModel() {
        return true;
      }
      async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
        this.calls.push(structuredClone(params));
        const hit = params.messages.some(
          (m) =>
            m.role === "system" &&
            m.content.some(
              (c) => c.type === "text" && c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT),
            ),
        );
        if (hit) {
          yield { type: "text.delta", delta: "傀儡水位收尾" };
        } else {
          yield { type: "tool.call", toolCallId: "tc_1", name: "read_probe", arguments: {} };
        }
        yield { type: "step.end" };
      }
    }
    const readTool: Tool = {
      name: "read_probe",
      description: "probe",
      parameters: z.object({}),
      accesses: [{ resource: "file", action: "read" }],
      async execute() {
        return { success: true, output: "ok" };
      },
    };
    const provider = new LoopProvider();
    // 型号表存在但未配置 contextWindow：W 链应回落 runtime.maxContextTokens=10
    const configRepository = {
      load: async () => ({
        providers: [
          {
            id: "p1",
            displayName: "P1",
            providerType: "openai" as const,
            baseUrl: "http://localhost",
            models: [{ id: "mock", displayName: "Mock", modelType: "llm" as const }],
          },
        ],
        settings: {
          memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
        },
      }),
    } as unknown as ConfigRepository;
    const runner = new PuppetRunner({
      getRuntime: async () => ({
        provider,
        model: "mock",
        providerId: "p1",
        maxContextTokens: 10,
        configRepository,
        tools: [readTool],
        workspaceDir: os.tmpdir(),
      }),
    });

    const output = await runner.run("a1", "do work");

    // 若缺 maxContextTokens 档会落 80_000，走工具循环；回退档 10 使首步预检即撞顶
    expect(output).toBe("傀儡水位收尾");
    expect(provider.calls).toHaveLength(2);
    expect(
      provider.calls[0]!.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(CONTEXT_WATERMARK_SUMMARY_HINT)),
      ),
    ).toBe(true);
    expect(
      provider.calls[1]!.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((c) => c.type === "text" && c.text.includes(HANDOFF_WRITING_GUIDANCE)),
      ),
    ).toBe(true);
  });
});

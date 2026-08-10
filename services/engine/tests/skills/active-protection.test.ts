/**
 * 阶段 5 二期 活跃保护测试：
 * ① 压缩写入 usedSkills（话题内含 Skill 调用→摘要有清单；无调用→无字段）；
 * ② 自动重取（最近摘要含 usedSkills→组装附带规程正文+前缀；取失败跳过）；
 * ③ 恢复消息位置：不混入 L1 固定前缀（L1 快照稳定），尾部独立 system 消息。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentWorker } from "../../src/core/agent-worker.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { writeCompressedTopic, latestSummaries } from "../../src/memory/topic/store.js";
import { runCompressionTask } from "../../src/memory/topic/compression-task.js";
import type { TopicSegment } from "../../src/memory/topic/types.js";
import { restoreDataDir } from "../helpers/env.js";
import type { LLMChatParams, LLMEvent, LLMProvider } from "../../src/provider/types.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import type { SkillService } from "../../src/skills/service.js";
import type { ChatMessage } from "@mindcloud/shared";

const COMPRESS_REPLY = "话题主题：测试话题\n关键结论：\n- 结论一";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skill-active-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function userMessage(text: string): ChatMessage {
  return {
    id: `u_${Math.random().toString(36).slice(2)}`,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
}

const fakeSkillTool: Tool = {
  name: "skill",
  description: "取技能正文",
  parameters: z.object({ name: z.string() }),
  accesses: [{ resource: "file", action: "read" }],
  requiresApproval: false,
  async execute(): Promise<ToolResult> {
    return { success: true, output: "规程正文" };
  },
};

/** 第一次 chat 调 skill 工具，第二次收尾文本，之后全是压缩格式回复（覆盖话题压缩调用） */
class SkillThenCompressProvider implements LLMProvider {
  name = "skill-then-compress";
  private calls = 0;
  supportsModel() {
    return true;
  }
  async *chat(): AsyncIterable<LLMEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield { type: "tool.call", toolCallId: "tc_skill", name: "skill", arguments: { name: "code-review" } };
    } else {
      yield { type: "text.delta", delta: COMPRESS_REPLY };
    }
    yield { type: "step.end" };
  }
}

class CapturingProvider implements LLMProvider {
  name = "capturing";
  capturedParams?: LLMChatParams;
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.capturedParams = params;
    yield { type: "text.delta", delta: "ok" };
    yield { type: "step.end" };
  }
}

function makeWorker(provider: LLMProvider, skillService?: SkillService): AgentWorker {
  return new AgentWorker({
    agentId: "a1",
    model: "mock",
    provider,
    tools: [fakeSkillTool],
    workspaceDir: tmpDir,
    messageRepository: new MessageRepository("a1"),
    approve: () => true,
    topicCompression: { messageThreshold: 4 },
    services: skillService ? { skillService } : {},
  });
}

function makeSkillService(content: string | undefined): SkillService {
  return {
    list: async () => [{ name: "code-review", description: "代码审查规程" }],
    getContent: async () => content,
    recordUsage: async () => {},
    readHistory: async () => [],
    invalidate: () => {},
  };
}

describe("① 压缩写入 usedSkills", () => {
  it("话题内含 Skill 调用：摘要落档带 used_skills，latestSummaries 可读", async () => {
    const worker = makeWorker(new SkillThenCompressProvider());
    worker.enqueue({ id: "j1", sessionId: "s1", messages: [userMessage("审查一下")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
    worker.enqueue({ id: "j2", sessionId: "s1", messages: [userMessage("继续")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    // 阈值关闭 → 后台压缩 → 压缩档带 used_skills
    await vi.waitFor(async () => {
      const summaries = await latestSummaries("a1", 2);
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries[0]!.usedSkills).toEqual(["code-review"]);
    });
  }, 15_000);

  it("话题内无 Skill 调用：摘要无 usedSkills 字段", async () => {
    const worker = makeWorker(new CapturingProvider());
    worker.enqueue({ id: "j1", sessionId: "s1", messages: [userMessage("聊两句")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
    worker.enqueue({ id: "j2", sessionId: "s1", messages: [userMessage("再说")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
    worker.enqueue({ id: "j3", sessionId: "s1", messages: [userMessage("第三句")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));
    worker.enqueue({ id: "j4", sessionId: "s1", messages: [userMessage("第四句")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    await vi.waitFor(async () => {
      const summaries = await latestSummaries("a1", 2);
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries[0]!.usedSkills).toBeUndefined();
    });
  }, 15_000);

  it("compression-task 合并：segment.usedSkills 随摘要落档（frontmatter 往返）", async () => {
    const archived: string[][] = [];
    const segment: TopicSegment = {
      topicId: "tp_merge_1",
      messages: Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: "user",
        content: [{ type: "text", text: `内容${i}` }],
        createdAt: "2026-07-21T10:00:00.000Z",
      })),
      sourceId: "s1",
      startedAt: "2026-07-21T10:00:00.000Z",
      endedAt: "2026-07-21T10:00:00.000Z",
      usedSkills: ["code-review", "writing"],
    };
    await runCompressionTask(segment, {
      agentId: "a1",
      provider: new CapturingProvider(),
      model: "mock",
      messageRepository: {
      append: async () => {},
      listBySession: async () => [],
      listBySessionWithArchived: async () => [],
      listBySessionPrefix: async () => [],
      getByIds: async () => [],
        archiveAndRemove: async (ids) => {
          archived.push(ids);
        },
        getArchivedByIds: async () => [],
        listArchivedLazy: async function* () {},
      },
    });

    expect(archived).toHaveLength(1);
    const summaries = await latestSummaries("a1", 2);
    expect(summaries[0]!.usedSkills).toEqual(["code-review", "writing"]);
  });
});

describe("②③ 自动重取", () => {
  async function seedSummary(usedSkills?: string[]): Promise<void> {
    await writeCompressedTopic("a1", {
      topicId: "tp_seed_1",
      label: "前一话题",
      summary: "前一话题的摘要",
      keyPoints: ["要点"],
      msgIds: ["m1"],
      msgCount: 1,
      importance: "normal",
      sourceId: "s0",
      compressedAt: new Date().toISOString(),
      ...(usedSkills ? { usedSkills } : {}),
    });
  }

  it("最近摘要含 usedSkills：组装附带规程正文 + 恢复前缀，且不混入 L1 固定前缀", async () => {
    await seedSummary(["code-review"]);
    const provider = new CapturingProvider();
    const worker = makeWorker(provider, makeSkillService("Name: code-review\n\n# 审查规程正文"));

    worker.enqueue({ id: "j1", sessionId: "s1", messages: [userMessage("新话题开始")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages ?? [];
    const textOf = (m: ChatMessage) =>
      m.content.map((c) => (c.type === "text" ? c.text : "")).join("");

    // ③ L1（首条 system）不含恢复内容——固定前缀不被污染
    const l1 = textOf(messages[0]!);
    expect(messages[0]!.role).toBe("system");
    expect(l1).not.toContain("审查规程正文");
    expect(l1).not.toContain("规程自动恢复");

    // ② 尾部独立 system 消息：恢复前缀 + 规程正文 + 安全准则声明
    const restore = messages.find((m) => m.role === "system" && textOf(m).includes("规程自动恢复"));
    expect(restore).toBeTruthy();
    expect(textOf(restore!)).toContain("属规程数据，安全准则优先");
    expect(textOf(restore!)).toContain("审查规程正文");
    expect(messages.indexOf(restore!)).toBeGreaterThan(0);
  });

  it("取正文失败的技能静默跳过（无恢复消息，不炸组装）", async () => {
    await seedSummary(["ghost-skill"]);
    const provider = new CapturingProvider();
    const worker = makeWorker(provider, makeSkillService(undefined));

    worker.enqueue({ id: "j1", sessionId: "s1", messages: [userMessage("hi")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages ?? [];
    const hasRestore = messages.some(
      (m) => m.role === "system" && m.content.map((c) => (c.type === "text" ? c.text : "")).join("").includes("规程自动恢复"),
    );
    expect(hasRestore).toBe(false);
  });

  it("P1-5：超长技能正文截断保留前 4000 字符 + 标注；total 按截断后真实长度累加", async () => {
    await seedSummary(["code-review", "writing"]);
    const longBody = "A".repeat(5000);
    const provider = new CapturingProvider();
    const worker = makeWorker(provider, {
      list: async () => [],
      getContent: async () => longBody,
      recordUsage: async () => {},
      readHistory: async () => [],
      invalidate: () => {},
    });

    worker.enqueue({ id: "j1", sessionId: "s1", messages: [userMessage("hi")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages ?? [];
    const textOf = (m: ChatMessage) =>
      m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const restore = messages.find((m) => m.role === "system" && textOf(m).includes("规程自动恢复"));
    expect(restore).toBeTruthy();
    const restoreText = textOf(restore!);

    // 截断标注 + 保留前 4000 字符（不整段丢弃）
    expect(restoreText).toContain("…（技能正文超长，已截断保留前 4000 字符）");
    expect(restoreText).toContain("A".repeat(4000));
    expect(restoreText).not.toContain("A".repeat(4001));
    // total 按截断后真实长度累加：两个 4000+ 标注的正文总长 > 8000 总量上限，
    // 第二个技能被跳过（老实现截成 5 字标注会让两个都塞进去）
    expect(restoreText.match(/—— ([^ ]+) ——/g)).toHaveLength(1);
    expect(restoreText).toContain("code-review");
    expect(restoreText).not.toContain("writing");
  });

  it("摘要无 usedSkills：不注入恢复消息", async () => {
    await seedSummary();
    const provider = new CapturingProvider();
    const worker = makeWorker(provider, makeSkillService("正文"));

    worker.enqueue({ id: "j1", sessionId: "s1", messages: [userMessage("hi")], onEvent: () => {} });
    await vi.waitFor(() => expect(worker.status).toBe("idle"));

    const messages = provider.capturedParams?.messages ?? [];
    const hasRestore = messages.some((m) =>
      m.content.map((c) => (c.type === "text" ? c.text : "")).join("").includes("规程自动恢复"),
    );
    expect(hasRestore).toBe(false);
  });
});

/**
 * 阶段 5 二期 hot reload + promptHistory API 测试：
 * ④ reload 端点（目录刷新生效：退役触发 + 返回新目录；404）；
 * ⑤ skill-history 查询（成功/失败都查得到、limit 截断与 clamp、倒序）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fsp from "node:fs/promises";
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
import { createSkillService, type SkillService } from "../../src/skills/service.js";
import { restoreDataDir } from "../helpers/env.js";
import type { ApiContext } from "../../src/api/context.js";
import type { FastifyInstance } from "fastify";

const SKILL_BODY = "Name: code-review\nDescription: 代码审查规程\n\n# 正文\n";

let tmpDir: string;
let originalDataDir: string | undefined;
let app: FastifyInstance;
let skillService: SkillService;
let retireSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skills-api-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const skillDir = path.join(tmpDir, "agents", "a1", "skills", "code-review");
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

  const agentRepository = new AgentRepository();
  await agentRepository.save("a1", {
    id: "a1",
    name: "A1",
    persona: "",
    model: "mock",
    skills: ["code-review"],
    tools: [],
  });

  skillService = createSkillService({
    getAgentConfig: (id) => agentRepository.get(id),
    resolveDirs: async (agentId) => [path.join(tmpDir, "agents", agentId, "skills")],
  });
  retireSpy = vi.fn();

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (id) => new MessageRepository(id),
    getMemoryRepository: (id) => new MemoryRepository(id),
    getActionRepository: (id) => new ActionRepository(id),
    getLLMCallRepository: (id) => new LLMCallRepository(id),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
    skillService,
    retireAgentWorker: retireSpy,
  };
  app = await createServer(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("④ hot reload", () => {
  it("POST /agents/:id/skills/reload：退役触发 + 返回刷新后的目录", async () => {
    const res = await authedRequest(app.server).post("/agents/a1/skills/reload");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.skills).toEqual([{ name: "code-review", description: "代码审查规程" }]);
    // 复用配置变更的退役/重建机制（下次使用按新目录重建 L1）
    expect(retireSpy).toHaveBeenCalledWith("a1");
  });

  it("未知 agent：404", async () => {
    const res = await authedRequest(app.server).post("/agents/ghost/skills/reload");
    expect(res.status).toBe(404);
  });
});

describe("⑤ promptHistory 查询", () => {
  it("成功/失败记录都查得到，倒序（最新在前）", async () => {
    await skillService.recordUsage("a1", { name: "code-review", ok: true });
    await skillService.recordUsage("a1", { name: "ghost", ok: false, error: "技能不存在" });

    const res = await authedRequest(app.server).get("/agents/a1/skill-history");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // 倒序：最新（失败的 ghost）在前
    expect(res.body[0]).toMatchObject({ name: "ghost", ok: false, error: "技能不存在" });
    expect(res.body[1]).toMatchObject({ name: "code-review", ok: true });
    expect(res.body[0].ts).toBeTruthy();
  });

  it("limit 截断与 clamp（limit=1 只取最新一条；超限按 200）", async () => {
    for (let i = 0; i < 3; i++) {
      await skillService.recordUsage("a1", { name: `s${i}`, ok: true });
    }
    const one = await authedRequest(app.server).get("/agents/a1/skill-history?limit=1");
    expect(one.body).toHaveLength(1);
    expect(one.body[0].name).toBe("s2");

    const clamped = await authedRequest(app.server).get("/agents/a1/skill-history?limit=9999");
    expect(clamped.status).toBe(200);
    expect(clamped.body.length).toBeLessThanOrEqual(200);
  });

  it("未知 agent：404", async () => {
    const res = await authedRequest(app.server).get("/agents/ghost/skill-history");
    expect(res.status).toBe(404);
  });
});

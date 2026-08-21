import { describe, it, expect, afterEach } from "vitest";
import { authedRequest } from "../helpers/auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { createServer } from "../../src/api/server.js";
import { AgentRepository } from "../../src/memory/repositories/agent.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { MemoryRepository } from "../../src/memory/repositories/memory.js";
import { ActionRepository } from "../../src/memory/repositories/action.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { SessionRepository } from "../../src/conductor/repository.js";
import { BlueprintRepository } from "../../src/blueprint/repository.js";
import type { ApiContext } from "../../src/api/context.js";
import type { ExternalFace } from "../../src/plugins/external/index.js";
import { restoreDataDir } from "../helpers/env.js";

async function buildTestContext(
  external?: ExternalFace,
): Promise<{ context: ApiContext; tmpDir: string; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-api-test-"));
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;

  const context: ApiContext = {
    agentRepository: new AgentRepository(),
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: new ConfigRepository(),
    sessionRepository: new SessionRepository(),
    blueprintRepository: new BlueprintRepository(),
    getAgentWorker: async () => undefined,
    ...(external !== undefined ? { external } : {}),
  };

  return {
    context,
    tmpDir,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      restoreDataDir(originalDataDir);
    },
  };
}

describe("Plugins API", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup();
  });

  it("GET /plugins 返回 external 面的 loaded/skipped/perAgent 三字段", async () => {
    const external: ExternalFace = {
      loaded: ["hello"],
      skipped: [{ name: "broken", reason: "missing-entry" }],
      perAgent: [
        { agentId: "a1", name: "hello", status: "loaded" },
        { agentId: "a2", name: "hello", status: "disabled" },
      ],
    };
    const built = await buildTestContext(external);
    cleanup = built.cleanup;
    const app = await createServer(built.context);
    await app.ready();

    const res = await authedRequest(app.server).get("/plugins");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      loaded: ["hello"],
      skipped: [{ name: "broken", reason: "missing-entry" }],
      perAgent: [
        { agentId: "a1", name: "hello", status: "loaded" },
        { agentId: "a2", name: "hello", status: "disabled" },
      ],
    });
    await app.close();
  });

  it("GET /plugins 在 external 面未装配时按空结果返回（不 500）", async () => {
    const built = await buildTestContext();
    cleanup = built.cleanup;
    const app = await createServer(built.context);
    await app.ready();

    const res = await authedRequest(app.server).get("/plugins");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ loaded: [], skipped: [], perAgent: [] });
    await app.close();
  });
});

// M1：清单读写端点。临时目录当 DATA_DIR（buildTestContext 已接管 CLOUDMIND_DATA_DIR），
// 插件目录/清单文件现场写盘；写断言直接读落盘文件原文（JSON.parse / js-yaml load）。
describe("Plugins manifest API（M1：全局清单读写）", () => {
  let cleanup: () => Promise<void>;
  let tmpDir: string;

  afterEach(async () => {
    await cleanup();
  });

  async function setup() {
    const built = await buildTestContext();
    cleanup = built.cleanup;
    tmpDir = built.tmpDir;
    const app = await createServer(built.context);
    await app.ready();
    return { app, context: built.context };
  }

  /** 现场造插件目录（withEntry=false 时无 index.mjs：目录在但不算可加载插件） */
  async function writePluginDir(name: string, withEntry = true): Promise<void> {
    const dir = path.join(tmpDir, "plugins", name);
    await fs.mkdir(dir, { recursive: true });
    if (withEntry) {
      await fs.writeFile(
        path.join(dir, "index.mjs"),
        `export const name = ${JSON.stringify(name)};\nexport function apply() {}\n`,
      );
    }
  }

  async function writeGlobalManifest(manifest: unknown): Promise<void> {
    await fs.writeFile(path.join(tmpDir, "plugins.json"), JSON.stringify(manifest));
  }

  async function readGlobalManifestFile(): Promise<unknown> {
    return JSON.parse(await fs.readFile(path.join(tmpDir, "plugins.json"), "utf-8"));
  }

  it("GET /plugins/manifest 合并清单条目与未登记目录", async () => {
    const { app } = await setup();
    await writePluginDir("alpha"); // 已登记
    await writePluginDir("gamma"); // 未登记（有 index.mjs）→ unregistered
    await writePluginDir("delta", false); // 无 index.mjs → 不进 unregistered
    await writeGlobalManifest({
      plugins: { alpha: { enabled: false, config: { x: 1 } }, beta: {} },
    });

    const res = await authedRequest(app.server).get("/plugins/manifest");
    expect(res.status).toBe(200);
    // beta 无插件目录也按清单条目列出（hasEntry 指标清单条目存在）；缺省 enabled=true、config={}
    expect(res.body).toEqual({
      plugins: [
        { name: "alpha", enabled: false, config: { x: 1 }, hasEntry: true },
        { name: "beta", enabled: true, config: {}, hasEntry: true },
      ],
      unregistered: ["gamma"],
    });
    await app.close();
  });

  it("GET /plugins/manifest 清单文件缺失按空清单（目录全量进 unregistered）", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");
    await writePluginDir("gamma");

    const res = await authedRequest(app.server).get("/plugins/manifest");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plugins: [], unregistered: ["alpha", "gamma"] });
    await app.close();
  });

  it("GET /plugins/manifest 清单文件损坏 → 409 显式报错", async () => {
    const { app } = await setup();
    await fs.writeFile(path.join(tmpDir, "plugins.json"), "{oops");

    const res = await authedRequest(app.server).get("/plugins/manifest");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("解析失败");
    await app.close();
  });

  it("PUT /plugins/manifest/:name 未登记插件 → 创建登记（清单文件原本不存在）", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");

    const res = await authedRequest(app.server)
      .put("/plugins/manifest/alpha")
      .send({ enabled: true, config: { greeting: "hi" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "alpha",
      enabled: true,
      config: { greeting: "hi" },
      requiresRestart: true,
    });
    expect(await readGlobalManifestFile()).toEqual({
      plugins: { alpha: { enabled: true, config: { greeting: "hi" } } },
    });
    await app.close();
  });

  it("PUT /plugins/manifest/:name 更新 enabled：config 与其他条目原样保留", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");
    await writePluginDir("beta");
    await writeGlobalManifest({
      plugins: { alpha: { enabled: true, config: { k: "v" } }, beta: { enabled: true } },
    });

    const res = await authedRequest(app.server).put("/plugins/manifest/alpha").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "alpha", enabled: false, config: { k: "v" }, requiresRestart: true });
    expect(await readGlobalManifestFile()).toEqual({
      plugins: { alpha: { enabled: false, config: { k: "v" } }, beta: { enabled: true } },
    });
    await app.close();
  });

  it("PUT /plugins/manifest/:name 更新 config 为整体替换，不传 enabled 保留原值", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");
    await writeGlobalManifest({ plugins: { alpha: { enabled: false, config: { old: 1 } } } });

    const res = await authedRequest(app.server).put("/plugins/manifest/alpha").send({ config: { new: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "alpha", enabled: false, config: { new: 2 }, requiresRestart: true });
    expect(await readGlobalManifestFile()).toEqual({
      plugins: { alpha: { enabled: false, config: { new: 2 } } },
    });
    await app.close();
  });

  it("PUT /plugins/manifest/:name 插件目录不存在 → 404（清单文件不创建）", async () => {
    const { app } = await setup();

    const res = await authedRequest(app.server).put("/plugins/manifest/ghost").send({ enabled: true });
    expect(res.status).toBe(404);
    await expect(fs.access(path.join(tmpDir, "plugins.json"))).rejects.toThrow();
    await app.close();
  });

  it("PUT /plugins/manifest/:name 目录存在但名字非法 → 400", async () => {
    const { app } = await setup();
    await writePluginDir("my.plugin"); // 目录合法存在，但不在白名单字符集内

    const res = await authedRequest(app.server).put("/plugins/manifest/my.plugin").send({ enabled: true });
    expect(res.status).toBe(400);
    await app.close();
  });

  it("PUT /plugins/manifest/:name 清单文件损坏 → 409 且不覆盖原文件", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");
    await fs.writeFile(path.join(tmpDir, "plugins.json"), "{broken");

    const res = await authedRequest(app.server).put("/plugins/manifest/alpha").send({ enabled: false });
    expect(res.status).toBe(409);
    // 绝不覆盖：原损坏文件一字节不动
    expect(await fs.readFile(path.join(tmpDir, "plugins.json"), "utf-8")).toBe("{broken");
    await app.close();
  });

  it("PUT /plugins/manifest/:name config 非对象（数组/标量）→ 400", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");

    const asArray = await authedRequest(app.server).put("/plugins/manifest/alpha").send({ config: [1, 2] });
    expect(asArray.status).toBe(400);
    const asScalar = await authedRequest(app.server).put("/plugins/manifest/alpha").send({ config: "str" });
    expect(asScalar.status).toBe(400);
    await app.close();
  });

  it("PUT /plugins/manifest/:name 缺字段 / enabled 非布尔 → 400", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");

    const empty = await authedRequest(app.server).put("/plugins/manifest/alpha").send({});
    expect(empty.status).toBe(400);
    const badEnabled = await authedRequest(app.server).put("/plugins/manifest/alpha").send({ enabled: "yes" });
    expect(badEnabled.status).toBe(400);
    await app.close();
  });
});

describe("Plugins manifest API（M1：per-agent 清单读写）", () => {
  let cleanup: () => Promise<void>;
  let tmpDir: string;

  afterEach(async () => {
    await cleanup();
  });

  const AGENT_FIXTURE = { id: "a1", name: "A1", persona: "", skills: [], tools: [] };

  async function setup() {
    const built = await buildTestContext();
    cleanup = built.cleanup;
    tmpDir = built.tmpDir;
    const app = await createServer(built.context);
    await app.ready();
    return { app, context: built.context };
  }

  async function writePluginDir(name: string): Promise<void> {
    const dir = path.join(tmpDir, "plugins", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.mjs"),
      `export const name = ${JSON.stringify(name)};\nexport function apply() {}\n`,
    );
  }

  function agentManifestPath(): string {
    return path.join(tmpDir, "agents", "a1", "plugins.yml");
  }

  async function readAgentManifestFile(): Promise<{ plugins?: Record<string, unknown> }> {
    return (loadYaml(await fs.readFile(agentManifestPath(), "utf-8")) ?? {}) as {
      plugins?: Record<string, unknown>;
    };
  }

  it("GET /agents/:id/plugins/manifest 缺文件按空清单", async () => {
    const { app, context } = await setup();
    await context.agentRepository.save("a1", AGENT_FIXTURE);

    const res = await authedRequest(app.server).get("/agents/a1/plugins/manifest");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plugins: [] });
    await app.close();
  });

  it("GET /agents/:id/plugins/manifest 读 yml 条目（缺省 enabled=true、config={}）", async () => {
    const { app, context } = await setup();
    await context.agentRepository.save("a1", AGENT_FIXTURE);
    await fs.writeFile(
      agentManifestPath(),
      "plugins:\n  alpha:\n    enabled: false\n    config:\n      key: value\n  beta: {}\n",
    );

    const res = await authedRequest(app.server).get("/agents/a1/plugins/manifest");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      plugins: [
        { name: "alpha", enabled: false, config: { key: "value" } },
        { name: "beta", enabled: true, config: {} },
      ],
    });
    await app.close();
  });

  it("GET /agents/:id/plugins/manifest agent 不存在 → 404，非法 id → 400", async () => {
    const { app } = await setup();

    const notFound = await authedRequest(app.server).get("/agents/ghost/plugins/manifest");
    expect(notFound.status).toBe(404);
    const invalid = await authedRequest(app.server).get("/agents/bad%20id/plugins/manifest");
    expect(invalid.status).toBe(400);
    await app.close();
  });

  it("GET /agents/:id/plugins/manifest yml 损坏 → 409", async () => {
    const { app, context } = await setup();
    await context.agentRepository.save("a1", AGENT_FIXTURE);
    await fs.writeFile(agentManifestPath(), "plugins:\n  alpha: [unclosed\n");

    const res = await authedRequest(app.server).get("/agents/a1/plugins/manifest");
    expect(res.status).toBe(409);
    await app.close();
  });

  it("PUT /agents/:id/plugins/manifest/:name 新建登记写回 yml（其他条目保留）", async () => {
    const { app, context } = await setup();
    await context.agentRepository.save("a1", AGENT_FIXTURE);
    await writePluginDir("alpha");
    await writePluginDir("beta");
    await fs.writeFile(agentManifestPath(), "plugins:\n  alpha:\n    enabled: true\n");

    const res = await authedRequest(app.server)
      .put("/agents/a1/plugins/manifest/beta")
      .send({ enabled: false, config: { n: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "beta", enabled: false, config: { n: 1 }, requiresRestart: true });
    // js-yaml dump 回写：alpha 原样保留，beta 新登记
    const doc = await readAgentManifestFile();
    expect(doc.plugins).toEqual({
      alpha: { enabled: true },
      beta: { enabled: false, config: { n: 1 } },
    });
    await app.close();
  });

  it("PUT /agents/:id/plugins/manifest/:name 缺文件 → 创建 plugins.yml", async () => {
    const { app, context } = await setup();
    await context.agentRepository.save("a1", AGENT_FIXTURE);
    await writePluginDir("alpha");

    const res = await authedRequest(app.server).put("/agents/a1/plugins/manifest/alpha").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "alpha", enabled: true, config: {}, requiresRestart: true });
    const doc = await readAgentManifestFile();
    expect(doc.plugins).toEqual({ alpha: { enabled: true } });
    await app.close();
  });

  it("PUT /agents/:id/plugins/manifest/:name agent 不存在 → 404", async () => {
    const { app } = await setup();
    await writePluginDir("alpha");

    const res = await authedRequest(app.server).put("/agents/ghost/plugins/manifest/alpha").send({ enabled: true });
    expect(res.status).toBe(404);
    await app.close();
  });

  it("PUT /agents/:id/plugins/manifest/:name 插件目录不存在 → 404，名字非法 → 400", async () => {
    const { app, context } = await setup();
    await context.agentRepository.save("a1", AGENT_FIXTURE);

    const notFound = await authedRequest(app.server).put("/agents/a1/plugins/manifest/ghost").send({ enabled: true });
    expect(notFound.status).toBe(404);
    const invalid = await authedRequest(app.server).put("/agents/a1/plugins/manifest/bad.name").send({ enabled: true });
    expect(invalid.status).toBe(400);
    await app.close();
  });

  it("PUT /agents/:id/plugins/manifest/:name yml 损坏 → 409 且不覆盖原文件", async () => {
    const { app, context } = await setup();
    await context.agentRepository.save("a1", AGENT_FIXTURE);
    await writePluginDir("alpha");
    const broken = "plugins:\n  alpha: [unclosed\n";
    await fs.writeFile(agentManifestPath(), broken);

    const res = await authedRequest(app.server).put("/agents/a1/plugins/manifest/alpha").send({ enabled: false });
    expect(res.status).toBe(409);
    expect(await fs.readFile(agentManifestPath(), "utf-8")).toBe(broken);
    await app.close();
  });
});

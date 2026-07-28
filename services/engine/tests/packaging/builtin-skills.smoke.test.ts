import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * 内置 skills 打包冒烟（P5-6，功能 review M4）：
 * 复刻 P0-4 的产物布局（engine/bootstrap.js + 毗邻 packages/skills + CJS 标记），
 * 以生产形态（cwd = engine 目录，模拟 supervisor 的 current_dir=entry.parent()）
 * 起真实 bundle，断言内置 core skill 经 /skills 可加载。
 * 另覆盖 ZOME_BUILTIN_SKILLS_DIR env 兜底（向上查找不命中的部署形态）。
 *
 * 与 prepare-engine.mjs 的差异：只 stage skill 加载链依赖的三样（bundle/skills/
 * package.json 标记），不下载内嵌 node（与 skill 加载无关）；真实 staging 布局
 * 已由 prepare-engine.mjs + 人工冒烟实证（见 P5-6 commit 报告）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(HERE, "../../../..");
const ENGINE_DIR = path.join(MONOREPO_ROOT, "services", "engine");
const AUTH = "p56-smoke-token";

interface BootedEngine {
  child: ChildProcess;
  baseUrl: string;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch { /* 已退出 */ }
  } else {
    try {
      child.kill("SIGTERM");
    } catch { /* 已退出 */ }
  }
}

async function bootEngine(bundlePath: string, cwd: string, port: number, extraEnv: Record<string, string> = {}): Promise<BootedEngine> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zome-p56-data-"));
  const child = spawn(process.execPath, [bundlePath], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "e2e",
      PORT: String(port),
      CLOUDMIND_DATA_DIR: dataDir,
      CLOUDMIND_AUTH_TOKEN: AUTH,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errTail = "";
  const appendLog = (c: Buffer) => {
    errTail = (errTail + c.toString()).slice(-3000);
  };
  child.stderr?.on("data", appendLog);
  child.stdout?.on("data", appendLog); // pino 日志与启动报错都走 stdout
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`staged engine 退出（code=${child.exitCode}）：${errTail.slice(-400)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return { child, baseUrl: `http://127.0.0.1:${port}` };
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  killTree(child);
  throw new Error(`staged engine 20s 内未就绪：${errTail.slice(-400)}`);
}

async function listSkills(baseUrl: string): Promise<{ name: string }[]> {
  const res = await fetch(`${baseUrl}/skills`, { headers: { Authorization: `Bearer ${AUTH}` } });
  if (!res.ok) throw new Error(`GET /skills -> ${res.status}`);
  return res.json() as Promise<{ name: string }[]>;
}

describe("内置 skills 打包冒烟（P5-6）", () => {
  let stageDir = "";
  let bundlePath = "";
  let port = 18_900 + (process.pid % 90);
  const booted: BootedEngine[] = [];

  beforeAll(async () => {
    // 复刻 P0-4 staging 布局：engine/bootstrap.js（CJS bundle）+ packages/skills + CJS 标记
    stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zome-p56-stage-"));
    const stagedEngine = path.join(stageDir, "engine");
    await fsp.mkdir(stagedEngine, { recursive: true });
    const require = createRequire(path.join(ENGINE_DIR, "package.json"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- esbuild 无类型导出入口（与 prepare-engine.mjs 同款用法）
    const esbuild = require("esbuild") as any;
    bundlePath = path.join(stagedEngine, "bootstrap.js");
    await esbuild.build({
      entryPoints: [path.join(ENGINE_DIR, "src", "bootstrap.ts")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outfile: bundlePath,
      logLevel: "silent",
    });
    await fsp.writeFile(
      path.join(stagedEngine, "package.json"),
      JSON.stringify({ name: "zome-engine-bundle", private: true, type: "commonjs" }),
    );
    // tiktoken wasm：bundle 启动时按 __dirname 读取（与 prepare-engine.mjs 同款）
    const tiktokenEntry = path.dirname(require.resolve("@dqbd/tiktoken", { paths: [ENGINE_DIR] }));
    let tiktokenDir = tiktokenEntry;
    for (let i = 0; i < 8 && !fs.existsSync(path.join(tiktokenDir, "package.json")); i++) {
      tiktokenDir = path.dirname(tiktokenDir);
    }
    await fsp.copyFile(path.join(tiktokenDir, "tiktoken_bg.wasm"), path.join(stagedEngine, "tiktoken_bg.wasm"));
    // swagger-ui 注册时读 __dirname/static/logo.svg（缺则启动抛 ENOENT，与 prepare-engine.mjs 同款）
    const swaggerEntry = path.dirname(require.resolve("@fastify/swagger-ui", { paths: [ENGINE_DIR] }));
    let swaggerDir = swaggerEntry;
    for (let i = 0; i < 8 && !fs.existsSync(path.join(swaggerDir, "package.json")); i++) {
      swaggerDir = path.dirname(swaggerDir);
    }
    await fsp.cp(path.join(swaggerDir, "static"), path.join(stagedEngine, "static"), { recursive: true });
    await fsp.cp(path.join(MONOREPO_ROOT, "packages", "skills"), path.join(stagedEngine, "packages", "skills"), {
      recursive: true,
    });
  }, 120_000);

  afterAll(async () => {
    for (const b of booted) {
      killTree(b.child);
      await new Promise<void>((r) => {
        b.child.once("exit", () => r());
        setTimeout(r, 5_000);
      });
    }
    if (stageDir) await fsp.rm(stageDir, { recursive: true, force: true });
  });

  it("生产布局（cwd=engine 目录）：内置 core skill 经 /skills 可加载", async () => {
    const engine = await bootEngine(bundlePath, path.dirname(bundlePath), port++);
    booted.push(engine);
    const skills = await listSkills(engine.baseUrl);
    expect(skills.map((s) => s.name)).toContain("core");
  }, 60_000);

  it("env 兜底（向上查找不命中的 cwd + ZOME_BUILTIN_SKILLS_DIR）：core 仍可加载", async () => {
    const neutralCwd = await fsp.mkdtemp(path.join(os.tmpdir(), "zome-p56-neutral-"));
    const engine = await bootEngine(bundlePath, neutralCwd, port++, {
      ZOME_BUILTIN_SKILLS_DIR: path.join(MONOREPO_ROOT, "packages", "skills"),
    });
    booted.push(engine);
    const skills = await listSkills(engine.baseUrl);
    expect(skills.map((s) => s.name)).toContain("core");
  }, 60_000);
});

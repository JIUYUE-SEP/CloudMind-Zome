import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-e2e-"));

process.env.CLOUDMIND_DATA_DIR = tmpDir;
process.env.NODE_ENV = "e2e";

// engine 本地 token 鉴权（P0-2）：e2e 环境给 engine 和 web 注入同一固定 token，
// tests/e2e 里直连 engine REST 的用例也用这个值
process.env.CLOUDMIND_AUTH_TOKEN = "e2e-test-token";

// e2e 引擎直起（不经 pnpm dev 的 tsx watch）：tsx watch 在 node spawn
// (shell:true + pipe) 下于本机静默卡死（banner 后无任何输出，纯净代码同现，
// 属预存环境问题）；e2e 一次性运行不需要 watch，直起 tsx 语义相同。
const engine = spawn("npx", ["tsx", "src/bootstrap.ts"], {
  cwd: path.join(root, "services", "engine"),
  stdio: "pipe",
  shell: true,
  env: { ...process.env, CLOUDMIND_DATA_DIR: tmpDir, NODE_ENV: "e2e" },
});

/**
 * 包管理器解析（2026-11-01 review H-2）：仓库用 corepack 固定 pnpm 版本
 * （`packageManager: pnpm@10.33.0`），该环境下 `pnpm` 不在 PATH——硬编码
 * `spawn("pnpm")` 直接 shell 报「不是内部或外部命令」，web 从未启动，
 * 60s 后只得到一句 "did not become ready"，真因埋在 [web-err] 里。
 *
 * 优先用调用方注入的 `npm_execpath`（经 `pnpm test:e2e` 启动时由 pnpm 自己
 * 写入，值形如 `.../.tools/pnpm.cjs`），用当前 node 直跑它最稳；
 * 否则回退 `corepack pnpm`（corepack 随 Node 分发，必然可用）。
 */
function resolvePnpm() {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath)) {
    return { cmd: process.execPath, args: [execPath] };
  }
  return { cmd: "corepack", args: ["pnpm"] };
}

const pm = resolvePnpm();
const web = spawn(pm.cmd, [...pm.args, "--filter", "@cloudmind/web", "dev"], {
  cwd: root,
  stdio: "pipe",
  shell: true,
  env: {
    ...process.env,
    CLOUDMIND_DATA_DIR: tmpDir,
    NODE_ENV: "e2e",
    NUXT_PUBLIC_ENGINE_URL: "http://127.0.0.1:8848",
    NUXT_PUBLIC_ENGINE_TOKEN: "e2e-test-token",
  },
});

// 启动期快速失败：子进程秒退时不要白等 60s（waitForUrl 只会报「URL 没就绪」，
// 真因在 [web-err]/[engine-err] 的日常日志里）——就绪后关闭此守卫，避免正常关停误报
let starting = true;
function failFast(name, code, signal) {
  if (!starting) return;
  starting = false;
  console.error(
    `[${name}] 进程在就绪前退出（code=${code} signal=${signal}）——检查上方 [${name}-err] 日志`,
  );
  engine.kill();
  web.kill();
  process.exit(1);
}
engine.on("exit", (code, signal) => failFast("engine", code, signal));
web.on("exit", (code, signal) => failFast("web", code, signal));

function log(name, data) {
  const lines = String(data).trim().split("\n");
  for (const line of lines) {
    console.log(`[${name}] ${line}`);
  }
}

engine.stdout.on("data", (data) => log("engine", data));
engine.stderr.on("data", (data) => log("engine-err", data));
web.stdout.on("data", (data) => log("web", data));
web.stderr.on("data", (data) => log("web-err", data));

async function waitForUrl(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not become ready`);
}

try {
  console.log("waiting for engine...");
  await waitForUrl("http://127.0.0.1:8848/health");
  console.log("waiting for web...");
  await waitForUrl("http://localhost:3000");
  starting = false; // 就绪后退场：正常关停的子进程退出不该被当成启动失败
  console.log("ready");
} catch (err) {
  console.error(err);
  engine.kill();
  web.kill();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}

async function shutdown() {
  console.log("shutting down...");
  engine.kill();
  web.kill();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  engine.kill();
  web.kill();
});

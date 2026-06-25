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

const engine = spawn("pnpm", ["--filter", "@mindcloud/engine", "dev"], {
  cwd: root,
  stdio: "pipe",
  shell: true,
  env: { ...process.env, CLOUDMIND_DATA_DIR: tmpDir, NODE_ENV: "e2e" },
});

const web = spawn("pnpm", ["--filter", "@mindcloud/web", "dev"], {
  cwd: root,
  stdio: "pipe",
  shell: true,
  env: {
    ...process.env,
    CLOUDMIND_DATA_DIR: tmpDir,
    NODE_ENV: "e2e",
    NUXT_PUBLIC_ENGINE_URL: "http://127.0.0.1:8848",
  },
});

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

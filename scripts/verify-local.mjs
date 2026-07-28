// 本地验证链：一次跑全 CI 的所有检查关，避免 push 后 CI 才挂。
// 覆盖：eslint（turbo lint）、typecheck、vitest、cargo fmt --check、cargo clippy、cargo test。
// 用法：pnpm verify
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sidecarDir = path.join(root, "crates", "zome-sidecar");

// prost-build 需要 protoc；优先用环境变量，否则回退到仓内 workspace/tools/protoc
function resolveProtoc() {
  if (process.env.PROTOC) return;
  const name = os.platform() === "win32" ? "protoc.exe" : "protoc";
  const bundled = path.join(root, "workspace", "tools", "protoc", "bin", name);
  if (fs.existsSync(bundled)) {
    process.env.PROTOC = bundled;
    console.log(`[verify] PROTOC=${bundled}`);
  }
}

const isWin = os.platform() === "win32";
// Windows 上 pnpm 是 .cmd，CreateProcess 不能直接执行，需 shell:true
// （DEP0190 告警无害：这里的参数全是脚本内常量，无外部输入）
const pnpmShell = isWin;

const steps = [
  { name: "eslint (turbo lint)", cmd: "pnpm", args: ["lint"], cwd: root, shell: pnpmShell },
  { name: "typecheck", cmd: "pnpm", args: ["typecheck"], cwd: root, shell: pnpmShell },
  { name: "vitest (turbo test)", cmd: "pnpm", args: ["test"], cwd: root, shell: pnpmShell },
  { name: "cargo fmt --check", cmd: "cargo", args: ["fmt", "--check"], cwd: sidecarDir },
  {
    name: "cargo clippy",
    cmd: "cargo",
    // --all-targets 比 CI（仅 lib/bin）更严，连测试代码的 lint 一起拦
    args: ["clippy", "--all-targets", "--", "-D", "warnings"],
    cwd: sidecarDir,
  },
  { name: "cargo test", cmd: "cargo", args: ["test"], cwd: sidecarDir },
];

resolveProtoc();

for (const step of steps) {
  console.log(`\n[verify] === ${step.name} ===`);
  const result = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    stdio: "inherit",
    shell: step.shell === true,
  });
  if (result.status !== 0) {
    console.error(`\n[verify] FAILED: ${step.name} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n[verify] all checks passed");

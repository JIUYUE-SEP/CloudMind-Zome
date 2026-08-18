/**
 * 准备 Tauri externalBin 的 sidecar 二进制。
 *
 * M46：先 cargo build 再拷贝——接入 tauri beforeBuildCommand 后，打包用的
 * 二进制新鲜度由 cargo 增量构建保证（源码未变时 build 秒级空转，变了必重编），
 * 不再依赖"人工记得先构建"（P0-4 Minor-3：过期 sidecar 静默打进包）。
 *
 * 用法：node scripts/prepare-sidecar.mjs [debug|release]（默认 debug；
 * 打包链经 apps/desktop/scripts/prepare-sidecar.mjs 转发，显式传 release）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const target = process.argv[2] || "debug";
const profile = target === "release" ? "release" : "debug";

function getTargetTriple() {
  const output = execSync("rustc -vV", { encoding: "utf8", cwd: root });
  const match = output.match(/host:\s*([^\s]+)/);
  return match ? match[1] : "";
}

const triple = getTargetTriple();
// triple 为空会让产物变成 zome-sidecar-.exe 而 Tauri 运行时找不到——fail fast
if (!triple) {
  console.error("Cannot determine rustc host triple (rustc -vV has no host line)");
  process.exit(1);
}
const isWin = os.platform() === "win32";
const binaryName = isWin ? "zome-sidecar.exe" : "zome-sidecar";
const crateDir = path.join(root, "crates", "zome-sidecar");
const source = path.join(crateDir, "target", profile, binaryName);
const destBase = isWin ? `zome-sidecar-${triple}.exe` : `zome-sidecar-${triple}`;
const destDir = path.join(root, "apps", "desktop", "src-tauri", "binaries");
const dest = path.join(destDir, destBase);

// 先构建（M46）：增量构建保证新鲜度可验证，失败直接中断打包
console.log(`Building zome-sidecar (${profile})...`);
const build = spawnSync("cargo", ["build", ...(profile === "release" ? ["--release"] : [])], {
  stdio: "inherit",
  shell: true,
  cwd: crateDir,
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!fs.existsSync(source)) {
  console.error(`Sidecar binary not found at ${source} after cargo build`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, dest);
console.log(`Prepared sidecar binary: ${dest}`);

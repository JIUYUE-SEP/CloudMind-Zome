/**
 * P0-4：把 engine 打成可分发产物并 staging 到 Tauri resources。
 *
 * 产出布局（apps/desktop/src-tauri/resources/，打进安装包）：
 *   resources/engine/bootstrap.js        esbuild 单文件 CJS bundle（~4.5MB）
 *   resources/engine/tiktoken_bg.wasm    @dqbd/tiktoken 运行时按 __dirname 读取
 *   resources/engine/static/             @fastify/swagger-ui 注册时读 static/logo.svg
 *   resources/engine/packages/skills/    findBuiltinSkillsDir 从 cwd 向上找的兼容布局
 *   resources/engine/crates/zome-sidecar/proto/zome.proto  findProtoPath 兼容布局
 *   resources/node/node(.exe)            内嵌 Node 运行时（用户机器零依赖）
 *
 * supervisor 的 engine_entry()/node_bin() 会在 sidecar exe 旁的
 * engine/ 与 resources/engine/、node/ 与 resources/node/ 查找，两边布局一致。
 *
 * 用法：node scripts/prepare-engine.mjs
 * 环境变量：ZOME_EMBEDDED_NODE_VERSION 覆盖内嵌 Node 版本（默认 22.14.0，对齐 .nvmrc 的 22）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const engineDir = path.join(root, "services", "engine");
const resourcesDir = path.join(root, "apps", "desktop", "src-tauri", "resources");
const stagingEngine = path.join(resourcesDir, "engine");
const stagingNode = path.join(resourcesDir, "node");
const NODE_VERSION = process.env.ZOME_EMBEDDED_NODE_VERSION || "22.14.0";

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

/** 经 node 模块解析定位 pnpm 布局下的包目录，避免硬编码 .pnpm 路径 */
function resolvePackageDir(pkgName) {
  const require = createRequire(path.join(engineDir, "package.json"));
  // 部分包（@dqbd/tiktoken）的 exports 不暴露 ./package.json，改为解析入口再向上找
  let dir = path.dirname(require.resolve(pkgName, { paths: [engineDir] }));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate package dir for ${pkgName}`);
}

async function bundleEngine() {
  console.log("[1/3] bundling engine with esbuild...");
  const require = createRequire(path.join(engineDir, "package.json"));
  const esbuild = require("esbuild");
  fs.rmSync(stagingEngine, { recursive: true, force: true });
  fs.mkdirSync(stagingEngine, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(engineDir, "src", "bootstrap.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.join(stagingEngine, "bootstrap.js"),
    logLevel: "warning",
  });
  // 钉死 CJS 解释：staging 目录在 apps/desktop（type:module）之下时，
  // node 会按最近 package.json 把 .js 当 ESM，bundle 里的 require 直接炸
  fs.writeFileSync(
    path.join(stagingEngine, "package.json"),
    JSON.stringify({ name: "zome-engine-bundle", private: true, type: "commonjs" }, null, 2),
  );
}

function copyRuntimeAssets() {
  console.log("[2/3] copying runtime assets...");
  // tiktoken wasm：bundle 后 __dirname 指向 engine/ 目录，wasm 放旁边即可
  copyDir(
    path.join(resolvePackageDir("@dqbd/tiktoken"), "tiktoken_bg.wasm"),
    path.join(stagingEngine, "tiktoken_bg.wasm"),
  );
  // swagger-ui 注册时读 __dirname/static/logo.svg
  copyDir(
    path.join(resolvePackageDir("@fastify/swagger-ui"), "static"),
    path.join(stagingEngine, "static"),
  );
  // 兼容 findBuiltinSkillsDir / findProtoPath 的向上查找（cwd = engine/ 目录）
  copyDir(path.join(root, "packages", "skills"), path.join(stagingEngine, "packages", "skills"));
  copyDir(
    path.join(root, "crates", "zome-sidecar", "proto", "zome.proto"),
    path.join(stagingEngine, "crates", "zome-sidecar", "proto", "zome.proto"),
  );
}

function nodeDistTarget() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "win32" && arch === "x64") return { name: `node-v${NODE_VERSION}-win-x64`, ext: "zip", bin: "node.exe" };
  if (platform === "linux" && arch === "x64") return { name: `node-v${NODE_VERSION}-linux-x64`, ext: "tar.xz", bin: "node" };
  if (platform === "darwin" && arch === "arm64") return { name: `node-v${NODE_VERSION}-darwin-arm64`, ext: "tar.gz", bin: "node" };
  if (platform === "darwin" && arch === "x64") return { name: `node-v${NODE_VERSION}-darwin-x64`, ext: "tar.gz", bin: "node" };
  throw new Error(`unsupported platform/arch for embedded node: ${platform}/${arch}`);
}

async function downloadEmbeddedNode() {
  const target = nodeDistTarget();
  const destBinary = path.join(stagingNode, target.bin);
  if (fs.existsSync(destBinary)) {
    console.log(`[3/3] embedded node already staged: ${destBinary}（删除 resources/node 可强制刷新）`);
    return;
  }
  console.log(`[3/3] downloading embedded node v${NODE_VERSION} (${target.name})...`);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${target.name}.${target.ext}`;
  const cacheDir = path.join(resourcesDir, ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${target.name}.${target.ext}`);
  if (!fs.existsSync(archive)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }
  // 解包：Windows 用 PowerShell Expand-Archive（GNU tar 解不了 zip，且把 F:\ 误判为远程主机）；
  // unix 用系统 tar（覆盖 tar.xz/tar.gz）
  const extractDir = path.join(cacheDir, target.name);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const extract =
    os.platform() === "win32"
      ? spawnSync(
          "powershell",
          ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extractDir}' -Force`],
          { stdio: "inherit" },
        )
      : spawnSync("tar", ["-xf", archive, "-C", extractDir], { stdio: "inherit" });
  if (extract.status !== 0) throw new Error(`failed to extract ${archive}`);
  // zip 布局 node.exe 在根目录；tar 布局在 bin/node
  const binInArchive = path.join(extractDir, target.name, target.bin === "node.exe" ? "node.exe" : path.join("bin", "node"));
  if (!fs.existsSync(binInArchive)) throw new Error(`node binary not found in archive: ${binInArchive}`);
  fs.rmSync(stagingNode, { recursive: true, force: true });
  fs.mkdirSync(stagingNode, { recursive: true });
  fs.copyFileSync(binInArchive, destBinary);
  if (target.bin !== "node.exe") fs.chmodSync(destBinary, 0o755);
}

await bundleEngine();
copyRuntimeAssets();
await downloadEmbeddedNode();
console.log(`engine + embedded node staged under ${resourcesDir}`);

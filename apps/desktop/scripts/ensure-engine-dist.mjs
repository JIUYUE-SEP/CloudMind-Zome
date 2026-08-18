/**
 * desktop dev 的 engine 断链兜底（F16）：dev 链的 engine 由 sidecar 经
 * project_root 回退定位 services/engine/dist/src/bootstrap.js（tsc 产物，
 * 被 gitignore 不入库）。全新克隆首跑没有 dist：sidecar engine_entry 解析
 * 失败、engine 起不来，前端永停 not ready。dist 缺失时构建 engine
 * （`@mindcloud/engine...` 过滤器连带 workspace 依赖 shared 一起构建）。
 *
 * 取舍（与 ensure-web-dist.mjs 同口径）：dist 存在即跳过——engine 的 tsc 未开
 * incremental，每次 dev 都全量编译开销太大；改了 engine 源码需手动
 * `pnpm --filter @mindcloud/engine build`（或删掉 dist 让下次 dev 重建）。
 * 首跑稍慢（sidecar cargo build + engine tsc）属一次性成本。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const engineEntry = path.join(repoRoot, "services", "engine", "dist", "src", "bootstrap.js");

if (!fs.existsSync(engineEntry)) {
  console.log("Engine dist not found, building @mindcloud/engine (with workspace deps)...");
  const result = spawnSync("pnpm", ["--filter", "@mindcloud/engine...", "build"], {
    stdio: "inherit",
    shell: true,
    cwd: repoRoot,
  });
  process.exit(result.status ?? 1);
}

console.log("Engine dist already exists, skipping engine build.");

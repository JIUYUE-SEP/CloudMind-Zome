import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const distPath = path.join(repoRoot, "apps/web/dist/index.html");

if (!fs.existsSync(distPath)) {
  console.log("Web dist not found, building @mindcloud/web...");
  const result = spawnSync("pnpm", ["--filter", "@mindcloud/web", "build"], {
    stdio: "inherit",
    shell: true,
    cwd: repoRoot,
  });
  process.exit(result.status ?? 1);
}

console.log("Web dist already exists, skipping web build.");

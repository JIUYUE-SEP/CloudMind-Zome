import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const target = process.argv[2] || "debug";

function getTargetTriple() {
  const output = execSync("rustc -vV", { encoding: "utf8", cwd: root });
  const match = output.match(/host:\s*([^\s]+)/);
  return match ? match[1] : "";
}

const triple = getTargetTriple();
const isWin = os.platform() === "win32";
const binaryName = isWin ? "zome-sidecar.exe" : "zome-sidecar";
const sourceDir = path.join(root, "crates", "zome-sidecar", "target", target);
const source = path.join(sourceDir, binaryName);
const destBase = isWin ? `zome-sidecar-${triple}.exe` : `zome-sidecar-${triple}`;
const destDir = path.join(root, "apps", "desktop", "src-tauri", "binaries");
const dest = path.join(destDir, destBase);

if (!fs.existsSync(source)) {
  console.error(`Sidecar binary not found at ${source}`);
  console.error(
    `Build zome-sidecar first: cd crates/zome-sidecar && cargo build --${target === "release" ? "release" : "debug"}`
  );
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, dest);
console.log(`Prepared sidecar binary: ${dest}`);

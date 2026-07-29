/**
 * MCP client demo：连接 → listTools（含 annotations 原文）→ 调用只读工具 → 打印结果
 *
 * 用法：
 *   pnpm tsx src/demo-client.ts          # 官方 server-everything（经 npx）
 *   pnpm tsx src/demo-client.ts local    # 本地自写 server（src/server-local.ts）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? "everything";
const isWin = process.platform === "win32";

// Windows 坑：StdioClientTransport 内部 spawn(..., { shell: false })，
// 而 npx 在 Windows 上是 npx.cmd 批处理 shim，无 shell 无法执行 → 必须包 cmd.exe /c。
const serverParams =
  mode === "local"
    ? {
        // node.exe 是真实可执行文件，无 shell 问题；用 tsx 的 ESM loader 直接跑 TS server
        command: process.execPath,
        args: ["--import", "tsx", path.join(__dirname, "server-local.ts")],
      }
    : isWin
      ? {
          command: "cmd.exe",
          args: ["/c", "npx", "-y", "@modelcontextprotocol/server-everything"],
        }
      : { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] };

const transport = new StdioClientTransport({ ...serverParams, stderr: "inherit" });
const client = new Client(
  { name: "cmz-spike-client", version: "0.0.0" },
  { capabilities: {} },
);

await client.connect(transport);
console.log("=== 连接成功 ===");
console.log("server info:", JSON.stringify(client.getServerVersion()));
console.log("instructions:", client.getInstructions() ?? "(none)");

console.log("\n=== listTools（含 annotations 原文）===");
const { tools } = await client.listTools();
console.log(`共 ${tools.length} 个工具`);
for (const t of tools) {
  console.log(`\n- ${t.name}`);
  console.log(`  description: ${t.description ?? "(none)"}`);
  console.log(`  annotations: ${JSON.stringify(t.annotations ?? null)}`);
  console.log(
    `  inputSchema.required: ${JSON.stringify((t.inputSchema as { required?: string[] }).required ?? [])}`,
  );
}

// 挑一个只读工具实际调用
const callTarget =
  mode === "local"
    ? { name: "read_file", arguments: { path: "package.json" } }
    : { name: "echo", arguments: { message: "hello from CMZ spike" } };
console.log(`\n=== callTool: ${callTarget.name} ===`);
const result = await client.callTool(callTarget);
console.log(JSON.stringify(result, null, 2));

await client.close();
console.log("\n=== 完成 ===");

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../../logger.js";
import { getDataDir } from "../../config/paths.js";
import type { Tool } from "../types.js";
import { resolveCommandShim } from "./shim.js";
import { mcpToolToEngine } from "./wrapper.js";
import { McpServersFileSchema, type McpServerConfig } from "./types.js";

const CONNECT_TIMEOUT_MS = 15_000;

type ServerStatus = "ok" | "unavailable";

interface ServerEntry {
  config: McpServerConfig;
  status: ServerStatus;
  client?: Client;
  transport?: StdioClientTransport;
  tools: Tool[];
}

/** Windows 无进程组信号，杀整棵子进程树只能 taskkill /T /F（SDK close 只杀直接子进程） */
function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
}

/** tools/list 支持游标分页，聚齐全量 */
async function listAllTools(client: Client): Promise<McpTool[]> {
  const out: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    out.push(...res.tools);
    cursor = res.nextCursor;
  } while (cursor);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms).unref(),
    ),
  ]);
}

/**
 * 按配置启动/连接 stdio MCP server，维护 Client 池。
 * 单个 server 连接失败/崩溃按不可用降级（记 warn，不影响整体），
 * 与 sidecar 不可用静默降级的既有范式一致。
 */
export class McpClientManager {
  private readonly entries: ServerEntry[];

  constructor(configs: McpServerConfig[]) {
    const seen = new Set<string>();
    this.entries = [];
    for (const config of configs) {
      if (seen.has(config.name)) {
        logger.warn(`[mcp] server 名重复，跳过后一个：${config.name}`);
        continue;
      }
      seen.add(config.name);
      this.entries.push({ config, status: "unavailable", tools: [] });
    }
  }

  /** 加载 DATA_DIR/mcp-servers.json；文件不存在或解析失败均按空配置处理 */
  static loadDefault(): McpClientManager {
    const file = path.join(getDataDir(), "mcp-servers.json");
    if (!fs.existsSync(file)) return new McpClientManager([]);
    try {
      const parsed = McpServersFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
      return new McpClientManager(parsed.servers);
    } catch (err) {
      logger.warn({ err }, `[mcp] ${file} 解析失败，按空配置处理`);
      return new McpClientManager([]);
    }
  }

  /** 连接全部 server；单个失败降级为 unavailable，不抛出 */
  async connectAll(): Promise<void> {
    await Promise.allSettled(this.entries.map((entry) => this.connect(entry)));
  }

  private async connect(entry: ServerEntry): Promise<void> {
    const { name } = entry.config;
    // transport 声明在 try 外：StdioClientTransport 构造即 spawn 子进程，
    // 失败路径（catch）需要拿到它做清理，否则会泄漏子进程
    let transport: StdioClientTransport | undefined;
    try {
      const { command, args } = resolveCommandShim(entry.config.command, entry.config.args ?? []);
      transport = new StdioClientTransport({
        command,
        args,
        env: entry.config.env,
        // server 的 stdout 是协议通道，其调试输出走 stderr，转进 engine 日志（spike 坑 #3）
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        logger.debug(`[mcp][${name}][stderr] ${String(chunk).trimEnd()}`);
      });
      const client = new Client({ name: "cmz-engine", version: "0.1.0" }, { capabilities: {} });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[mcp] ${name} 连接`);
      const mcpTools = await withTimeout(
        listAllTools(client),
        CONNECT_TIMEOUT_MS,
        `[mcp] ${name} listTools`,
      );
      entry.client = client;
      entry.transport = transport;
      entry.tools = mcpTools.map((t) =>
        mcpToolToEngine(name, t, {
          // SDK 1.30 的 callTool 返回 CallToolResult 与 task 结果的联合；
          // 本模块只用同步结果形态，在此收窄（task 化工具接入留待后续包）
          callTool: (toolName, args) =>
            client.callTool({ name: toolName, arguments: args }) as Promise<CallToolResult>,
        }),
      );
      entry.status = "ok";
      transport.onclose = () => {
        if (entry.status === "ok") {
          entry.status = "unavailable";
          logger.warn(`[mcp] server ${name} 连接已断开，其工具不可用（不阻塞 engine）`);
        }
      };
      logger.info(`[mcp] server ${name} 已连接，暴露 ${entry.tools.length} 个工具`);
    } catch (err) {
      entry.status = "unavailable";
      logger.warn({ err }, `[mcp] server ${name} 连接失败，按不可用降级`);
      // 失败路径回收已 spawn 的子进程：entry.transport 未赋值，close() 扫不到它，
      // 必须在此清理；清理错误不再外抛，保持"单 server 失败降级"语义
      const pid = transport?.pid ?? null;
      if (process.platform === "win32" && pid !== null) {
        // Windows 下 SDK close 只杀直接子进程（cmd.exe shim），会留下孤儿 node；
        // 且 shim 死后 taskkill 找不到 pid，必须直接 taskkill /T /F 杀整棵进程树
        await killProcessTree(pid);
      } else if (transport) {
        try {
          await transport.close();
        } catch {
          // 关停期错误不影响降级
        }
      }
    }
  }

  /** 全部可用 server 的包装后工具（与内置工具同管线注入） */
  getTools(): Tool[] {
    return this.entries.filter((e) => e.status === "ok").flatMap((e) => e.tools);
  }

  /** 优雅断开全部连接，并扫除残留子进程树（engine 退出时由 shutdown close 调用） */
  async close(): Promise<void> {
    for (const entry of this.entries) {
      const pid = entry.transport?.pid ?? null;
      // 先置 unavailable：client.close() 会触发 transport.onclose，
      // 避免主动关停被误记为"连接已断开"的 warn
      entry.status = "unavailable";
      try {
        await entry.client?.close();
      } catch {
        // 关停期错误不影响整体退出
      }
      if (process.platform === "win32" && pid !== null) {
        await killProcessTree(pid);
      }
    }
  }
}

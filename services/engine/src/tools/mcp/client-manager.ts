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
import { sanitizeMcpNamePart } from "./naming.js";
import { wrapMcpTools, type McpToolCaller } from "./wrapper.js";
import { McpServerConfigSchema, type McpServerConfig } from "./types.js";

const CONNECT_TIMEOUT_MS = 15_000;

type ServerStatus = "ok" | "unavailable";

interface ServerEntry {
  config: McpServerConfig;
  status: ServerStatus;
  /** 代际戳：旧（重）连尝试迟到完成不覆盖新状态（kimi connection-manager attemptId 等价） */
  attemptId: number;
  client?: Client;
  transport?: StdioClientTransport;
  tools: Tool[];
  /**
   * 稳定调用口：包装工具持有它而非某个具体 client，调用时读 entry.client——
   * 重连换 client 后，既有工具快照（断线保注册）的后续调用自动落到新连接上
   */
  caller: McpToolCaller;
}

/** Windows 无进程组信号，杀整棵子进程树只能 taskkill /T /F（SDK close 只杀直接子进程） */
function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
}

/** tools/list 分页封顶：防恶意/故障 server 无限翻页耗尽内存（页数与总条数双封顶，M18） */
export const MAX_TOOLS_LIST_PAGES = 100;
export const MAX_TOOLS_PER_SERVER = 1000;

/** tools/list 支持游标分页，聚齐全量（页数/条数超限截断并 warn，不再继续翻页） */
export async function listAllTools(client: Client): Promise<McpTool[]> {
  const out: McpTool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    out.push(...res.tools);
    cursor = res.nextCursor;
    pages += 1;
    if (cursor && (pages >= MAX_TOOLS_LIST_PAGES || out.length >= MAX_TOOLS_PER_SERVER)) {
      logger.warn(
        `[mcp] tools/list 分页超限（${pages} 页 / ${out.length} 条），截断并丢弃剩余游标`,
      );
      break;
    }
  } while (cursor);
  return out;
}

/** 竞速结束后清掉输家定时器（unref 只是不拖住进程退出，定时器本身仍会驻留到触发——M18） */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 按配置启动/连接 stdio MCP server，维护 Client 池。
 * 单个 server 连接失败/崩溃按不可用降级（记 warn，不影响整体），
 * 与 sidecar 不可用静默降级的既有范式一致。
 *
 * 自愈（kimi「封顶一次」哲学）：工具调用失败由 wrapper 侧分类（探活/原地重试/
 * 重连后重试），重连经 reconnect() single-flight 合并同名并发；engine close() 后
 * disposed，不再发起任何重连。
 */
export class McpClientManager {
  private readonly entries: ServerEntry[];
  private readonly inFlightReconnects = new Map<string, Promise<boolean>>();
  private disposed = false;

  constructor(configs: McpServerConfig[]) {
    const seen = new Set<string>();
    this.entries = [];
    for (const config of configs) {
      // 按 sanitize 后名去重：原名不同但 sanitize 同形（"a b" vs "a_b"）会产生同名
      // mcp__ 工具，toolsMap 静默覆盖且 allowRemember 按限定名跨 entry 误放（review 建议）
      const sanitized = sanitizeMcpNamePart(config.name);
      if (seen.has(sanitized)) {
        logger.warn(
          `[mcp] server 名（sanitize 后）重复，跳过后一个：${config.name}（${sanitized}）`,
        );
        continue;
      }
      seen.add(sanitized);
      const entry: ServerEntry = {
        config,
        status: "unavailable",
        attemptId: 0,
        tools: [],
        caller: undefined as unknown as McpToolCaller,
      };
      entry.caller = {
        callTool: (toolName, args, opts) => {
          const client = entry.client;
          if (!client) {
            return Promise.reject(new Error(`[mcp] server ${config.name} 当前无可用连接`));
          }
          // SDK 1.30 的 callTool 返回 CallToolResult 与 task 结果的联合；
          // 本模块只用同步结果形态，在此收窄（task 化工具接入留待后续包）
          return client.callTool(
            { name: toolName, arguments: args },
            undefined,
            { timeout: opts?.timeoutMs },
          ) as Promise<CallToolResult>;
        },
        ping: (timeoutMs) => {
          const client = entry.client;
          if (!client) {
            return Promise.reject(new Error(`[mcp] server ${config.name} 当前无可用连接`));
          }
          return client.ping({ timeout: timeoutMs });
        },
      };
      this.entries.push(entry);
    }
  }

  /**
   * 加载 DATA_DIR/mcp-servers.json；文件不存在或整体 JSON 语法损坏按空配置处理。
   * servers 逐条 safeParse：非法条目跳过并 warn（带下标/name 与校验摘要，不落 env 等
   * 敏感值），单条坏配置不拖垮整体；servers 缺失/非数组按空数组处理。
   */
  static loadDefault(): McpClientManager {
    const file = path.join(getDataDir(), "mcp-servers.json");
    if (!fs.existsSync(file)) return new McpClientManager([]);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (err) {
      logger.warn({ err }, `[mcp] ${file} 解析失败，按空配置处理`);
      return new McpClientManager([]);
    }
    const rawServers = (raw as { servers?: unknown })?.servers;
    const list = Array.isArray(rawServers) ? rawServers : [];
    const configs: McpServerConfig[] = [];
    list.forEach((item, index) => {
      const result = McpServerConfigSchema.safeParse(item);
      if (result.success) {
        configs.push(result.data);
        return;
      }
      const name = (item as { name?: unknown })?.name;
      const summary = result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      logger.warn(
        `[mcp] ${file} 第 ${index} 条 server 配置非法，已跳过${
          typeof name === "string" && name !== "" ? `（name=${name}）` : ""
        }：${summary}`,
      );
    });
    return new McpClientManager(configs);
  }

  /** 连接全部 server；单个失败降级为 unavailable，不抛出 */
  async connectAll(): Promise<void> {
    await Promise.allSettled(this.entries.map((entry) => this.connect(entry, ++entry.attemptId)));
  }

  /**
   * 重连指定 server（single-flight：同名并发合并为同一次；attemptId 代际戳
   * 防旧尝试迟到覆盖；disposed 后一律拒绝）。成功 true，失败/不可重连 false。
   */
  async reconnect(serverName: string): Promise<boolean> {
    if (this.disposed) return false;
    const entry = this.entries.find((e) => e.config.name === serverName);
    if (!entry) return false;
    const existing = this.inFlightReconnects.get(serverName);
    if (existing) return existing;
    const work = this.reconnectEntry(entry).finally(() => {
      if (this.inFlightReconnects.get(serverName) === work) {
        this.inFlightReconnects.delete(serverName);
      }
    });
    this.inFlightReconnects.set(serverName, work);
    return work;
  }

  private async reconnectEntry(entry: ServerEntry): Promise<boolean> {
    const attemptId = ++entry.attemptId;
    // 先置 unavailable 并摘掉引用：旧 client close 触发的 onclose 不误记"意外断开"
    entry.status = "unavailable";
    const oldClient = entry.client;
    const oldTransport = entry.transport;
    entry.client = undefined;
    entry.transport = undefined;
    await this.disposeConnection(oldClient, oldTransport);
    if (!this.isCurrent(entry, attemptId)) return false;
    // 工具注册保留（断线保注册）：重连失败时旧 tools 快照仍在，
    // 后续调用降级为自愈/失败而非 tool not found
    await this.connect(entry, attemptId);
    // connect() 内的赋值对调用点收窄不可见，断言还原联合类型再比较
    return this.isCurrent(entry, attemptId) && (entry.status as ServerStatus) === "ok";
  }

  private isCurrent(entry: ServerEntry, attemptId: number): boolean {
    return !this.disposed && entry.attemptId === attemptId;
  }

  private async connect(entry: ServerEntry, attemptId: number): Promise<void> {
    const { name } = entry.config;
    // transport/client 声明在 try 外：StdioClientTransport 构造即 spawn 子进程，
    // 失败/迟到路径需要拿到它们做清理，否则会泄漏子进程
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
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
      client = new Client({ name: "cmz-engine", version: "0.1.0" }, { capabilities: {} });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[mcp] ${name} 连接`);
      const mcpTools = await withTimeout(
        listAllTools(client),
        CONNECT_TIMEOUT_MS,
        `[mcp] ${name} listTools`,
      );
      if (!this.isCurrent(entry, attemptId)) {
        // 旧尝试迟到完成：回收新连接，不覆盖新一代状态
        await this.disposeConnection(client, transport);
        return;
      }
      entry.client = client;
      entry.transport = transport;
      entry.tools = wrapMcpTools(name, mcpTools, entry.caller, (_tool, qualifiedName) => ({
        // 审批覆盖：toolOverrides > annotations 映射；key 为限定名
        override: entry.config.toolOverrides?.[qualifiedName],
        callTimeoutMs: entry.config.callTimeoutMs,
        hooks: {
          reconnect: async () => ((await this.reconnect(name)) ? entry.caller : undefined),
        },
      }));
      entry.status = "ok";
      const connectedClient = client;
      transport.onclose = () => {
        if (!this.isCurrent(entry, attemptId)) return;
        if (entry.client !== connectedClient) return;
        entry.status = "unavailable";
        logger.warn(`[mcp] server ${name} 连接已断开，工具调用将触发自愈重连（不阻塞 engine）`);
      };
      logger.info(`[mcp] server ${name} 已连接，暴露 ${entry.tools.length} 个工具`);
    } catch (err) {
      // 失败路径回收已 spawn 的子进程：entry.transport 未赋值，close() 扫不到它，
      // 必须在此清理；清理错误不再外抛，保持"单 server 失败降级"语义
      await this.disposeConnection(client, transport);
      if (!this.isCurrent(entry, attemptId)) return;
      entry.status = "unavailable";
      logger.warn({ err }, `[mcp] server ${name} 连接失败，按不可用降级`);
    }
  }

  /** 回收一条连接的 client 与子进程树（清理错误不外抛，保持降级语义） */
  private async disposeConnection(
    client: Client | undefined,
    transport: StdioClientTransport | undefined,
  ): Promise<void> {
    const pid = transport?.pid ?? null;
    if (process.platform === "win32" && pid !== null) {
      // Windows 下必须先杀整棵进程树：SDK close 只杀直接子进程（cmd.exe shim），
      // shim 先死 taskkill 就找不到 pid，会留下孤儿 node（失败路径回归护栏）
      await killProcessTree(pid);
      try {
        await client?.close();
      } catch {
        // 树已杀，close 报错（传输已死）属预期
      }
      return;
    }
    if (client) {
      try {
        await client.close();
      } catch {
        // 关停期错误不影响降级
      }
    } else if (transport) {
      try {
        await transport.close();
      } catch {
        // 关停期错误不影响降级
      }
    }
  }

  /**
   * 全部 server 的包装后工具快照（与内置工具同管线注入；快照注入，断线不摘除）。
   * 不按 status 过滤（断线保注册）：server 崩溃/未连通时快照仍在注入列表，
   * 调用时经 caller 明确报「当前无可用连接」或由 wrapper 触发自愈重连（见 entry.caller）。
   */
  getTools(): Tool[] {
    return this.entries.flatMap((e) => e.tools);
  }

  /**
   * WS 审批层的 remember 查询：仅 server 配置 toolOverrides[qualifiedName].allowRemember===true
   * 放行（无 override 维持禁止，fail-closed）。
   */
  isRememberAllowed(qualifiedName: string): boolean {
    return this.entries.some(
      (e) => e.config.toolOverrides?.[qualifiedName]?.allowRemember === true,
    );
  }

  /** 优雅断开全部连接并置 disposed（不再接受重连），扫除残留子进程树 */
  async close(): Promise<void> {
    this.disposed = true;
    for (const entry of this.entries) {
      // 代际戳 +1：在飞的 connect/reconnect 立即失效，迟到完成不覆写关停状态
      entry.attemptId += 1;
      // 先置 unavailable：client.close() 会触发 transport.onclose，
      // 避免主动关停被误记为"连接已断开"的 warn
      entry.status = "unavailable";
      const client = entry.client;
      const transport = entry.transport;
      entry.client = undefined;
      entry.transport = undefined;
      await this.disposeConnection(client, transport);
    }
  }
}

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../../logger.js";
import type { Tool, ToolResult } from "../types.js";
import { mapAnnotationsToApproval, mcpInputSchemaToZod } from "./convert.js";
import { qualifyMcpToolName, sanitizeMcpNamePart } from "./naming.js";
import type { McpToolOverride } from "./types.js";

/** MCP 工具的统一命名前缀，防与内置工具冲突，也供审批层识别（remember 判定） */
export const MCP_TOOL_PREFIX = "mcp__";

/** 单次 callTool 默认超时（server 配置 callTimeoutMs 可覆盖） */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

/** server 名 sanitize（kimi tool-naming 语义：白名单字符 + 下划线折叠，保留大小写） */
export function sanitizeMcpName(name: string): string {
  return sanitizeMcpNamePart(name);
}

export function mcpToolName(serverName: string, toolName: string): string {
  return qualifyMcpToolName(serverName, toolName);
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * 与 SDK Client 解耦的调用口，便于 InMemoryTransport 测试与未来传输层扩展。
 * 实现方应读当前活跃 client（重连后新 client 对既有包装工具自动生效）。
 */
export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<CallToolResult>;
  /** MCP spec 内建 ping，用于歧义失败后的探活；任何应答（含 MethodNotFound）都算活 */
  ping(timeoutMs: number): Promise<unknown>;
}

/** 调用侧自愈钩子：传输已死时重连并返回可用 caller；undefined = 不可重连（如 engine 已关停） */
export interface McpToolHooks {
  reconnect?: () => Promise<McpToolCaller | undefined>;
}

/** server 已应答的调用超时：SDK 以 RequestTimeout 拒绝（属于 McpError，不可恢复） */
const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

function isMcpConnectionClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === ErrorCode.ConnectionClosed
  );
}

function isMcpTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isMcpConnectionClosedError(error)) return true;
  return !(error instanceof McpError);
}

/**
 * 结果 schema 校验失败（SDK 对 tools/call 响应 ZodError 拒收）：服务器已应答，
 * 重连无意义；但它不是 McpError，需单独识别。按名字匹配（多份 zod 拷贝时 instanceof 不可靠）。
 */
function isMcpMalformedResultError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 歧义失败后的探活：ping 任何应答（含 MethodNotFound、结果解析失败）都算活；
 * 只有字节没走通（连接关闭、socket 错误）或探活自身超时（活 socket、死 server）算死。
 * 永不 reject。
 */
async function probeMcpLiveness(caller: McpToolCaller): Promise<boolean> {
  try {
    await caller.ping(LIVENESS_PROBE_TIMEOUT_MS);
    return true;
  } catch (error) {
    if (isMcpConnectionClosedError(error)) return false;
    if (isMcpMalformedResultError(error)) return true;
    if (error instanceof McpError) {
      return (error as Error & { code?: unknown }).code !== ErrorCode.RequestTimeout;
    }
    return false;
  }
}

/**
 * 调用侧自愈（kimi retryAfterReconnect 等价，「封顶一次」哲学——不做熔断器）：
 * - 不可恢复直接抛：用户取消（AbortError）/ 服务器已应答（McpError，含工具业务错误
 *   与调用超时）/ 畸形结果 schema 校验失败——重连不会改变答案；
 * - ConnectionClosed（传输已死，SDK 已 onclose）→ 直接进重连；
 * - 歧义错误 → 5s ping 探活：活则原地重试一次（重试时传输挂了才 fall through 进重连）；
 * - 重连 → 新 caller 重试一次。每次调用重连封顶一次；重连也失败时错误消息含
 *   「原始失败 + 重连失败」双重原因。
 *
 * 注意重试是 at-least-once：传输死在「server 已处理、响应未到达」窗口时，重试可能
 * 重复副作用——协议层无跨重连去重，该取舍与 kimi 一致、刻意接受。
 * （CMZ ToolContext 暂无 per-tool signal，用户取消经 AbortError 名字判定兜底。）
 */
async function callWithSelfHeal(
  caller: McpToolCaller,
  hooks: McpToolHooks,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<CallToolResult> {
  const isUnrecoverable = (e: unknown): boolean =>
    isAbortError(e) || !isMcpTransportFailure(e) || isMcpMalformedResultError(e);
  try {
    return await caller.callTool(toolName, args, { timeoutMs });
  } catch (error) {
    if (hooks.reconnect === undefined || isUnrecoverable(error)) throw error;

    let failure = error;
    if (!isMcpConnectionClosedError(failure)) {
      const alive = await probeMcpLiveness(caller);
      if (alive) {
        // 传输正常、失败是瞬时的：原地重试一次，省一次全量重连；
        // 探活到重试之间传输死了则 fall through 进重连（仍封顶一次）
        try {
          return await caller.callTool(toolName, args, { timeoutMs });
        } catch (retryError) {
          if (isUnrecoverable(retryError)) throw retryError;
          failure = retryError;
        }
      }
    }

    logger.warn(`[mcp] 工具调用失败（${toErrorMessage(failure)}），尝试重连后重试一次`);
    let freshCaller: McpToolCaller | undefined;
    try {
      freshCaller = await hooks.reconnect();
    } catch (reconnectError) {
      if (isAbortError(reconnectError)) throw reconnectError;
      throw new Error(
        `${toErrorMessage(failure)}（重连 MCP server 也失败：${toErrorMessage(reconnectError)}）`,
        { cause: reconnectError },
      );
    }
    if (freshCaller === undefined) throw failure;
    return freshCaller.callTool(toolName, args, { timeoutMs });
  }
}

/** 提取 callTool 返回为 engine ToolResult.output：优先 structuredContent，其次拼接 text 块 */
function extractOutput(result: CallToolResult): unknown {
  if ("structuredContent" in result && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const texts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  if (texts.length > 0) return texts.join("\n");
  return content;
}

export interface McpToolWrapOptions {
  hooks?: McpToolHooks;
  /** 本地覆盖（优先级高于 annotations 映射） */
  override?: McpToolOverride;
  callTimeoutMs?: number;
}

/**
 * 把一个 MCP tool 包装成 engine Tool 实例。
 * 审批优先级：toolOverrides.requiresApproval > annotations 映射（fail-closed）；
 * requiresApproval:false 是本地显式信任（免审批），true 强制更严。
 * execute 内转发 client.callTool，失败按 callWithSelfHeal 分类自愈（封顶一次）。
 */
export function mcpToolToEngine(
  serverName: string,
  tool: McpTool,
  caller: McpToolCaller,
  options: McpToolWrapOptions = {},
): Tool {
  const name = mcpToolName(serverName, tool.name);
  const requiresApproval =
    options.override?.requiresApproval ?? mapAnnotationsToApproval(tool.annotations).requiresApproval;
  const timeoutMs = options.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
  return {
    name,
    description: tool.description ?? tool.annotations?.title ?? name,
    parameters: mcpInputSchemaToZod(tool.inputSchema),
    accesses: [
      {
        // annotations 不含资源维度，只能粗判；openWorldHint=false 视为封闭域（本地）
        resource: tool.annotations?.openWorldHint === false ? "file" : "network",
        action: requiresApproval ? "write" : "read",
      },
    ],
    requiresApproval,
    async execute(_ctx, args): Promise<ToolResult> {
      try {
        const result = await callWithSelfHeal(
          caller,
          options.hooks ?? {},
          tool.name,
          (args ?? {}) as Record<string, unknown>,
          timeoutMs,
        );
        if (result.isError) {
          const output = extractOutput(result);
          return { success: false, error: typeof output === "string" ? output : JSON.stringify(output) };
        }
        return { success: true, output: extractOutput(result) };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  };
}

/**
 * 整 server 的工具映射：同名冲突（限定名撞车）/空名工具跳过记 warn，
 * 不让单个坏工具拖垮整个 server 的注册。
 * taskSupport==="required" 的 task 化工具同样跳过（M20）：SDK 的 callTool 会走
 * task 结果形态，client-manager 的 caller 只收窄支持同步结果，注册了也必然调用失败；
 * 按既有「坏工具跳过、warn 降级」风格不对 LLM 暴露，比每次调用报错好。
 * task 化执行接入后删除此过滤即可恢复注册。
 */
export function wrapMcpTools(
  serverName: string,
  mcpTools: McpTool[],
  caller: McpToolCaller,
  options: (tool: McpTool, qualifiedName: string) => McpToolWrapOptions,
): Tool[] {
  const seen = new Set<string>();
  const tools: Tool[] = [];
  for (const mcpTool of mcpTools) {
    const qualifiedName = mcpToolName(serverName, mcpTool.name);
    if (mcpTool.name.trim() === "") {
      logger.warn(`[mcp] server ${serverName} 暴露空名工具，跳过`);
      continue;
    }
    if (mcpTool.execution?.taskSupport === "required") {
      logger.warn(
        `[mcp] server ${serverName} 工具 ${qualifiedName} 要求 task 化执行（taskSupport=required），暂不支持，跳过`,
      );
      continue;
    }
    if (seen.has(qualifiedName)) {
      logger.warn(`[mcp] server ${serverName} 工具限定名冲突，跳过后一个：${qualifiedName}`);
      continue;
    }
    seen.add(qualifiedName);
    tools.push(mcpToolToEngine(serverName, mcpTool, caller, options(mcpTool, qualifiedName)));
  }
  return tools;
}

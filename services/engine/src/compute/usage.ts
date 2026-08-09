/**
 * 跨 agent LLM 用量聚合（GET /compute/usage 数据源）。
 *
 * 注意：本聚合直接逐行 JSON.parse llm_calls.jsonl，绕过 DocumentStore 的
 * schemaVersion 迁移门——llm_calls 升格式时需同步本文件的解析逻辑
 * （当前 v1 无迁移链，落档行仅多一个可忽略的 schemaVersion 冗余字段）。
 */
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { logger } from "../logger.js";
import { getDataDir } from "../config/paths.js";
import type { LLMCallRecord } from "../memory/repositories/types.js";

export interface UsageDateAggregate {
  date: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  errorCalls: number;
}

export interface UsageModelAggregate {
  provider: string;
  /** 真实 ProviderConfig.id（F2：新记录按 providerId 归组；旧记录无此字段） */
  providerId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface UsageAgentAggregate {
  agentId: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface ComputeUsage {
  dates: UsageDateAggregate[];
  tokens: UsageModelAggregate[];
  byAgent: UsageAgentAggregate[];
}

interface UsageAccumulators {
  byDate: Map<string, UsageDateAggregate>;
  byModel: Map<string, UsageModelAggregate>;
  byAgent: Map<string, UsageAgentAggregate>;
}

/** 非数值/负数 token 一律按 0 处理（历史记录缺 usage 记 0 是既有行为） */
function toTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 本地时区日期键（YYYY-MM-DD）：聚合口径与用户所在时区一致 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const DEBUG_LINE_MAX = 200;

function truncateForDebug(line: string): string {
  return line.length > DEBUG_LINE_MAX ? `${line.slice(0, DEBUG_LINE_MAX)}…` : line;
}

function newAccumulators(): UsageAccumulators {
  return { byDate: new Map(), byModel: new Map(), byAgent: new Map() };
}

/**
 * 逐行流式读取单个 agent 的 llm_calls.jsonl 并累加：
 * - 文件缺失（ENOENT）静默跳过；
 * - 坏行跳过记 debug、不中断（与 DocumentStore 坏行容忍同语义）；
 * - 不设 readLines 的 100MB 尺寸上限——llm_calls.jsonl 只增，
 *   聚合必须与 readLinesWhere 一样按行流式读，内存占用与文件大小无关。
 */
async function accumulateAgentFile(
  filePath: string,
  agentId: string,
  acc: UsageAccumulators,
): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const rl = createInterface({ input: handle.createReadStream() });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let record: Partial<LLMCallRecord>;
        try {
          const parsed: unknown = JSON.parse(line);
          // P2-1：JSON.parse("null")/"true" 成功但非对象，同样按坏行跳过，
          // 否则后续字段访问 TypeError 会让端点 500
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            logger.debug(
              { filePath },
              `[compute/usage] 跳过非对象行：${truncateForDebug(line)}`,
            );
            continue;
          }
          record = parsed as Partial<LLMCallRecord>;
        } catch (err) {
          logger.debug(
            { err: err },
            `[compute/usage] 跳过坏行（${filePath}）：${truncateForDebug(line)}`,
          );
          continue;
        }
        const createdAt = new Date(record.createdAt ?? "");
        if (Number.isNaN(createdAt.getTime())) {
          logger.debug({ filePath }, "[compute/usage] 跳过 createdAt 无效的记录");
          continue;
        }
        const promptTokens = toTokens(record.promptTokens);
        const completionTokens = toTokens(record.completionTokens);
        const provider = nonEmptyString(record.provider) ?? "unknown";
        const providerId = nonEmptyString(record.providerId);
        const model = nonEmptyString(record.model) ?? "unknown";
        // P2-3：目录名是落盘存储不变量（getAgentDir），归属以目录名为准；
        // 记录字段仅在缺失时兜底（本实现目录名恒有，即聚合恒按目录归属），
        // 两者不一致时 warn 一条提示落档漂移
        const recordAgentId = nonEmptyString(record.agentId);
        if (recordAgentId !== undefined && recordAgentId !== agentId) {
          logger.warn(
            { filePath, recordAgentId, agentId },
            "[compute/usage] 记录 agentId 与目录名不一致，以目录名为准",
          );
        }
        const isError = record.status === "error";

        const dateKey = formatLocalDate(createdAt);
        let dateAgg = acc.byDate.get(dateKey);
        if (!dateAgg) {
          dateAgg = { date: dateKey, promptTokens: 0, completionTokens: 0, calls: 0, errorCalls: 0 };
          acc.byDate.set(dateKey, dateAgg);
        }
        dateAgg.promptTokens += promptTokens;
        dateAgg.completionTokens += completionTokens;
        dateAgg.calls += 1;
        if (isError) dateAgg.errorCalls += 1;

        // F2：聚合键 = providerId ?? provider——新记录按稳定 id 归组（改 displayName
        // 不再拆行、重名 displayName 不再合并）；旧记录无 providerId 自然归入
        // 适配器名组，保持升级前后各自成组、不互相串并。
        const modelKey = `${providerId ?? provider}\u0000${model}`;
        let modelAgg = acc.byModel.get(modelKey);
        if (!modelAgg) {
          modelAgg = {
            provider,
            ...(providerId !== undefined ? { providerId } : {}),
            model,
            promptTokens: 0,
            completionTokens: 0,
            calls: 0,
          };
          acc.byModel.set(modelKey, modelAgg);
        }
        modelAgg.promptTokens += promptTokens;
        modelAgg.completionTokens += completionTokens;
        modelAgg.calls += 1;

        let agentAgg = acc.byAgent.get(agentId);
        if (!agentAgg) {
          agentAgg = { agentId, promptTokens: 0, completionTokens: 0, calls: 0 };
          acc.byAgent.set(agentId, agentAgg);
        }
        agentAgg.promptTokens += promptTokens;
        agentAgg.completionTokens += completionTokens;
        agentAgg.calls += 1;
      }
    } finally {
      rl.close();
    }
  } catch (err) {
    // P2-2：单文件故障隔离——文件缺失（ENOENT）静默跳过；
    // 其他读失败（EACCES/EISDIR/流中断）只 warn 跳过该 agent，不拖垮整个端点
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn({ err: err, filePath }, "[compute/usage] 读取 llm_calls.jsonl 失败，跳过该 agent");
  } finally {
    await handle?.close();
  }
}

/**
 * 跨 agent 用量聚合（第一版实时扫描，不缓存）：
 * 遍历 DATA_DIR/agents/ 下所有 agent 目录的 llm_calls.jsonl，
 * 按日（本地时区）、provider+model、agent 三维聚合 token 与调用数。
 */
export async function aggregateUsage(dataDir: string = getDataDir()): Promise<ComputeUsage> {
  const agentsDir = path.join(dataDir, "agents");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    // agents/ 目录不存在 = 没有任何用量数据，不视为错误
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { dates: [], tokens: [], byAgent: [] };
    }
    throw err;
  }

  const acc = newAccumulators();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await accumulateAgentFile(path.join(agentsDir, entry.name, "llm_calls.jsonl"), entry.name, acc);
  }

  return {
    dates: [...acc.byDate.values()].sort((a, b) => a.date.localeCompare(b.date, "en")),
    tokens: [...acc.byModel.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider, "en") || a.model.localeCompare(b.model, "en"),
    ),
    byAgent: [...acc.byAgent.values()].sort((a, b) => a.agentId.localeCompare(b.agentId, "en")),
  };
}

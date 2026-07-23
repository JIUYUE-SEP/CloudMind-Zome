import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../memory/document-store.js";
import { getDataDir } from "./paths.js";

// 按文件路径缓存"读取或创建"的 Promise（与 crypto.ts 的 master key 同一模式）：
// 避免每个请求都读盘；测试按用例换 CLOUDMIND_DATA_DIR 时各拿各的 token，互不串扰。
const tokenCache = new Map<string, Promise<string>>();

async function readOrCreateTokenFile(file: string): Promise<string> {
  try {
    const existing = (await fs.readFile(file, "utf-8")).trim();
    // 文件已存在则复用：重启 token 不变，前端/桌面端无需重配
    if (existing) return existing;
  } catch {
    // 读不到（不存在或权限问题）则走下方生成
  }
  const token = crypto.randomBytes(32).toString("hex");
  // 原子写 + 权限收紧（同 crypto.ts 的 .master-key 处理）
  const tmpPath = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmpPath, token, { mode: 0o600 });
  } catch {
    // Fallback for platforms where mode is not supported (e.g. Windows).
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmpPath, token);
  }
  await renameWithRetry(tmpPath, file);
  return token;
}

/**
 * 本地鉴权 token（P0-2）：engine 只绑 127.0.0.1，威胁模型是同机非浏览器进程。
 * CLOUDMIND_AUTH_TOKEN 环境变量优先（测试/e2e 注入）；否则读数据目录
 * auth-token 文件，不存在则随机生成并落盘（重启复用同一个 token）。
 */
export function getAuthToken(): Promise<string> {
  const envToken = process.env.CLOUDMIND_AUTH_TOKEN;
  if (envToken) return Promise.resolve(envToken);
  const file = getAuthTokenFilePath();
  let cached = tokenCache.get(file);
  if (!cached) {
    cached = readOrCreateTokenFile(file);
    tokenCache.set(file, cached);
  }
  return cached;
}

export function getAuthTokenFilePath(): string {
  return path.join(getDataDir(), "auth-token");
}

/** 仅供测试：清空按路径缓存的 token，模拟进程重启后的首次读取 */
export function __resetAuthTokenCacheForTests(): void {
  tokenCache.clear();
}

/** 常量时间比较；长度不同直接判负 */
export function isTokenValid(provided: string | undefined, expected: string): provided is string {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 从 `Authorization: Bearer <token>` 头提取 token（REST 唯一凭证通道） */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

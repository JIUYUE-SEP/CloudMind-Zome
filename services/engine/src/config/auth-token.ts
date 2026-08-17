import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../plugins/memory/document-store.js";
import { getDataDir } from "./paths.js";

// 按文件路径缓存"读取或创建"的 Promise（与 crypto.ts 的 master key 同一模式）：
// 避免每个请求都读盘；测试按用例换 CLOUDMIND_DATA_DIR 时各拿各的 token，互不串扰。
const tokenCache = new Map<string, Promise<string>>();

// token 的文本形态：32 字节随机数的 hex 编码（64 个小写十六进制字符）
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

async function readOrCreateTokenFile(file: string): Promise<string> {
  let existing: string | undefined;
  try {
    existing = (await fs.readFile(file, "utf-8")).trim();
  } catch (err) {
    // 只有"文件不存在"才走下方生成；权限/IO 等其他读取错误必须显式抛出——
    // 吞掉后重新生成会覆盖旧 token，所有已配置该 token 的客户端立即失联
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `auth-token 文件读取失败（${file}），已中止以防覆盖旧 token：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (existing !== undefined) {
    // 文件已存在则复用：重启 token 不变，前端/桌面端无需重配。
    // 但内容必须是合法 token——空文件/格式不符视为损坏，抛错而非覆盖
    if (!TOKEN_PATTERN.test(existing)) {
      throw new Error(
        `auth-token 文件损坏（${file}）：内容不是 64 位十六进制 token，请人工修复或删除该文件后重试`,
      );
    }
    return existing;
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
    // 失败（读取错误/文件损坏）时剔除缓存项：缓存住 rejected Promise
    // 会毒化后续所有调用，文件修复后也无从恢复
    cached.catch(() => tokenCache.delete(file));
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

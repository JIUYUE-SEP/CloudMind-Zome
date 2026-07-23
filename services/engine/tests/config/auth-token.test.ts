import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getAuthToken,
  getAuthTokenFilePath,
  __resetAuthTokenCacheForTests,
  isTokenValid,
  extractBearerToken,
} from "../../src/config/auth-token.js";
import { restoreDataDir } from "../helpers/env.js";

describe("config/auth-token", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  let originalEnvToken: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-token-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    originalEnvToken = process.env.CLOUDMIND_AUTH_TOKEN;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
    // 清掉 setup.ts 的全局注入，走文件生成路径
    delete process.env.CLOUDMIND_AUTH_TOKEN;
    __resetAuthTokenCacheForTests();
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    if (originalEnvToken === undefined) {
      delete process.env.CLOUDMIND_AUTH_TOKEN;
    } else {
      process.env.CLOUDMIND_AUTH_TOKEN = originalEnvToken;
    }
    __resetAuthTokenCacheForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("首次生成随机 token 并原子落盘，进程重启（缓存清空）后复用同一个", async () => {
    const token = await getAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // 落盘内容与返回值一致，且无 .tmp 残留
    expect(await fs.readFile(getAuthTokenFilePath(), "utf-8")).toBe(token);
    await expect(fs.access(`${getAuthTokenFilePath()}.tmp`)).rejects.toThrow();

    // 模拟进程重启：清掉模块缓存后必须读到文件里的同一个 token，而不是重新生成
    __resetAuthTokenCacheForTests();
    expect(await getAuthToken()).toBe(token);
  });

  it("CLOUDMIND_AUTH_TOKEN 环境变量优先于文件", async () => {
    process.env.CLOUDMIND_AUTH_TOKEN = "env-override-token";
    expect(await getAuthToken()).toBe("env-override-token");
  });

  it("isTokenValid 常量时间语义：相等为真，不同/不同长/缺失为假", () => {
    expect(isTokenValid("abc", "abc")).toBe(true);
    expect(isTokenValid("abc", "abd")).toBe(false);
    expect(isTokenValid("abc", "abcd")).toBe(false);
    expect(isTokenValid(undefined, "abc")).toBe(false);
  });

  it("extractBearerToken 只认 `Bearer ` 前缀", () => {
    expect(extractBearerToken("Bearer xyz")).toBe("xyz");
    expect(extractBearerToken("Bearer   ")).toBeUndefined();
    expect(extractBearerToken("bearer xyz")).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });
});

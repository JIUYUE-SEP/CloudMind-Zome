import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getEngineTokenFilePath,
  readEngineAuthToken,
} from "../../server/api/engine-token";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "web-engine-token-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.CLOUDMIND_DATA_DIR;
  } else {
    process.env.CLOUDMIND_DATA_DIR = originalDataDir;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("engine-token 文件路径（与 engine getDataDir 同口径）", () => {
  it("CLOUDMIND_DATA_DIR 优先", () => {
    expect(getEngineTokenFilePath()).toBe(path.join(tmpDir, "auth-token"));
  });

  it("未设置 CLOUDMIND_DATA_DIR 时缺省 ~/.cloudmind-zome/auth-token", () => {
    delete process.env.CLOUDMIND_DATA_DIR;
    expect(getEngineTokenFilePath()).toBe(
      path.join(os.homedir(), ".cloudmind-zome", "auth-token"),
    );
  });
});

describe("readEngineAuthToken 优雅降级", () => {
  it("文件存在：读取并 trim 内容", async () => {
    await fsp.writeFile(path.join(tmpDir, "auth-token"), "  token-123\n", "utf-8");
    expect(await readEngineAuthToken()).toBe("token-123");
  });

  it("文件不存在：返回空串", async () => {
    expect(await readEngineAuthToken()).toBe("");
  });

  it("文件为空：返回空串", async () => {
    await fsp.writeFile(path.join(tmpDir, "auth-token"), "   \n", "utf-8");
    expect(await readEngineAuthToken()).toBe("");
  });

  it("路径不可读（指向目录）：返回空串，不抛", async () => {
    await fsp.mkdir(path.join(tmpDir, "auth-token"));
    expect(await readEngineAuthToken()).toBe("");
  });
});

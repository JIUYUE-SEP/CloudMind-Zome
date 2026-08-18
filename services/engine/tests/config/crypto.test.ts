import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "../../src/config/crypto.js";
import { restoreDataDir } from "../helpers/env.js";

describe("config/crypto", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  let originalMasterKey: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    originalMasterKey = process.env.CLOUDMIND_MASTER_KEY;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
    // 清掉环境变量注入的主密钥，走密钥文件路径
    delete process.env.CLOUDMIND_MASTER_KEY;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreDataDir(originalDataDir);
    if (originalMasterKey === undefined) {
      delete process.env.CLOUDMIND_MASTER_KEY;
    } else {
      process.env.CLOUDMIND_MASTER_KEY = originalMasterKey;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function keyFilePath(): string {
    return path.join(tempDir, ".master-key");
  }

  /** 绕过模块直接用密钥文件内容解密，验证 encrypt 用的确实是文件里的那把密钥 */
  async function decryptWithFileKey(cipherText: string): Promise<string> {
    const key = Buffer.from((await fs.readFile(keyFilePath(), "utf-8")).trim(), "base64");
    const combined = Buffer.from(cipherText, "base64");
    // 密文布局同 crypto.ts（M49 起新布局）：iv(16) + authTag(16) + encrypted
    const iv = combined.subarray(0, 16);
    const authTag = combined.subarray(16, 32);
    const encrypted = combined.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
  }

  it("encrypts and decrypts a value (round-trip)", async () => {
    const plain = "sk-test-api-key-12345";
    const cipher = await encrypt(plain);
    expect(cipher).not.toBe(plain);
    const decrypted = await decrypt(cipher);
    expect(decrypted).toBe(plain);
  });

  it("produces different ciphertexts for the same plaintext", async () => {
    const plain = "same-plaintext";
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a).not.toBe(b);
  });

  it("复用已存在的合法密钥文件：两次 encrypt 都用文件里的同一把密钥", async () => {
    const fileContent = crypto.randomBytes(32).toString("base64");
    await fs.writeFile(keyFilePath(), fileContent, "utf-8");

    const a = await encrypt("plain-a");
    const b = await encrypt("plain-b");
    expect(await decryptWithFileKey(a)).toBe("plain-a");
    expect(await decryptWithFileKey(b)).toBe("plain-b");
    // 合法密钥文件绝不被改写
    expect(await fs.readFile(keyFilePath(), "utf-8")).toBe(fileContent);
  });

  it("密钥文件不存在时自动生成并原子落盘", async () => {
    const cipher = await encrypt("auto-gen");
    const encoded = await fs.readFile(keyFilePath(), "utf-8");
    // 落盘内容是合法 base64 且解码后恰好 32 字节，无 .tmp 残留
    expect(Buffer.from(encoded.trim(), "base64").length).toBe(32);
    await expect(fs.access(`${keyFilePath()}.tmp`)).rejects.toThrow();
    // 生成的密钥真实可用：文件密钥与模块内 decrypt 都能解开
    expect(await decryptWithFileKey(cipher)).toBe("auto-gen");
    expect(await decrypt(cipher)).toBe("auto-gen");
  });

  it("读取错误（EACCES）时抛出，且密钥文件不被改写", async () => {
    const fileContent = crypto.randomBytes(32).toString("base64");
    await fs.writeFile(keyFilePath(), fileContent, "utf-8");
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(eacces);

    await expect(encrypt("x")).rejects.toThrow(/主密钥文件读取失败/);
    expect(await fs.readFile(keyFilePath(), "utf-8")).toBe(fileContent);
  });

  it("密钥文件损坏（解码后长度不符）时抛出，且文件不被改写", async () => {
    const corrupt = crypto.randomBytes(16).toString("base64");
    await fs.writeFile(keyFilePath(), corrupt, "utf-8");

    await expect(encrypt("x")).rejects.toThrow(/主密钥文件损坏/);
    expect(await fs.readFile(keyFilePath(), "utf-8")).toBe(corrupt);
  });

  it("失败后缓存不被毒化：读取恢复后再次调用成功", async () => {
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eacces);
    await expect(encrypt("x")).rejects.toThrow(/主密钥文件读取失败/);
    spy.mockRestore();

    // 缓存若残留 rejected Promise，这里会直接再抛；正常则应生成密钥并可用
    const cipher = await encrypt("x");
    expect(await decrypt(cipher)).toBe("x");
    expect(Buffer.from((await fs.readFile(keyFilePath(), "utf-8")).trim(), "base64").length).toBe(32);
  });

  it("M49：encrypt 只产新布局（iv+tag+data，无 16 字节 salt 前缀）", async () => {
    const plain = "sk-new-layout-check";
    const cipher = await encrypt(plain);
    const combined = Buffer.from(cipher, "base64");
    // 新布局总长 = iv(16) + authTag(16) + 明文字节数；旧布局会多 16 字节 salt
    expect(combined.length).toBe(16 + 16 + Buffer.byteLength(plain, "utf-8"));
    expect(await decrypt(cipher)).toBe(plain);
  });

  it("M49：旧布局固化工件（salt+iv+tag+data）仍可解密", async () => {
    // 工件由 M49 修复前的 encrypt 真实产物固化（旧布局 salt(16)+iv(16)+tag(16)+data，
    // 总长 81 = 48 + 33 字节明文）；存量密文（provider apiKey 等）即此布局，必须可解
    const legacyKeyB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // 字节 0..31
    const legacyCipher =
      "rszb6cuXpuduJ0ZsnEdvINlFWWl1oimmZF5Q2LnWEGgm81zdWvzU/0F61I+SnF4qnrWE+6hBt/unqb0g8V7deU32kP5RrbGI8yisuQfxFCUY";
    await fs.writeFile(keyFilePath(), legacyKeyB64, "utf-8");

    expect(Buffer.from(legacyCipher, "base64").length).toBe(81);
    await expect(decrypt(legacyCipher)).resolves.toBe("sk-legacy-provider-key-0123456789");
  });

  it("M49：测试内构造的旧布局密文（随机 salt）同样可解，且新密文不受影响", async () => {
    const fileContent = crypto.randomBytes(32).toString("base64");
    await fs.writeFile(keyFilePath(), fileContent, "utf-8");
    const key = Buffer.from(fileContent, "base64");
    // 按旧布局手工加密：salt(16) + iv(16) + authTag(16) + data（复刻修复前 encrypt）
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update("sk-legacy-in-test", "utf-8"), cipher.final()]);
    const legacyCombined = Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]);

    await expect(decrypt(legacyCombined.toString("base64"))).resolves.toBe("sk-legacy-in-test");
    // 新旧混用：同一密钥下新布局密文照常 round-trip（先试新布局不会被旧布局误判）
    const newCipher = await encrypt("sk-new-after-legacy");
    await expect(decrypt(newCipher)).resolves.toBe("sk-new-after-legacy");
  });

  it("M49：篡改密文两种布局都解不开（authTag 防误解，不静默出错误明文）", async () => {
    const cipher = await encrypt("sk-tamper-check");
    const combined = Buffer.from(cipher, "base64");
    combined[combined.length - 1]! ^= 0xff; // 翻转末字节
    await expect(decrypt(combined.toString("base64"))).rejects.toThrow();
  });
});

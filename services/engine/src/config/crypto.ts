import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../memory/document-store.js";
import { getDataDir } from "./paths.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const SALT_LEN = 16;

// 按密钥文件路径缓存"读取或创建"的 Promise：
// 1) 避免并发首次调用各自生成不同密钥互相覆盖，导致已加密数据无法解密；
// 2) 避免每次加解密都重新读盘。
const keyCache = new Map<string, Promise<Buffer>>();

async function readOrCreateKeyFile(keyFile: string): Promise<Buffer> {
  try {
    const encoded = await fs.readFile(keyFile, "utf-8");
    return Buffer.from(encoded.trim(), "base64");
  } catch {
    const key = crypto.randomBytes(KEY_LEN);
    // 原子写：先写 tmp 再 rename，避免写一半崩溃留下半截密钥文件
    // （半截密钥可读但解不了密，且不会触发本分支重新生成）
    const tmpPath = `${keyFile}.tmp`;
    try {
      await fs.mkdir(path.dirname(keyFile), { recursive: true });
      await fs.writeFile(tmpPath, key.toString("base64"), { mode: 0o600 });
    } catch {
      // Fallback for platforms where mode is not supported (e.g. Windows).
      await fs.mkdir(path.dirname(keyFile), { recursive: true });
      await fs.writeFile(tmpPath, key.toString("base64"));
    }
    await renameWithRetry(tmpPath, keyFile);
    return key;
  }
}

async function getOrCreateMasterKey(): Promise<Buffer> {
  const envKey = process.env.CLOUDMIND_MASTER_KEY;
  if (envKey) {
    return crypto.scryptSync(envKey, "cloudmind-zome", KEY_LEN);
  }
  const keyFile = path.join(getDataDir(), ".master-key");
  let cached = keyCache.get(keyFile);
  if (!cached) {
    cached = readOrCreateKeyFile(keyFile);
    keyCache.set(keyFile, cached);
  }
  return cached;
}

export async function encrypt(plainText: string): Promise<string> {
  const key = await getOrCreateMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const salt = crypto.randomBytes(SALT_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return combined.toString("base64");
}

export async function decrypt(cipherText: string): Promise<string> {
  const key = await getOrCreateMasterKey();
  const combined = Buffer.from(cipherText, "base64");
  const iv = combined.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = combined.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const encrypted = combined.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}

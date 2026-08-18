import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../plugins/memory/document-store.js";
import { getDataDir } from "./paths.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
// M49 前旧密文布局的 salt 前缀长度：该 salt 生成后从未参与 KDF（解密端直接
// 跳过），是纯死数据，已停止生成；保留常量仅供旧布局密文的解密偏移
const LEGACY_SALT_LEN = 16;

// 按密钥文件路径缓存"读取或创建"的 Promise：
// 1) 避免并发首次调用各自生成不同密钥互相覆盖，导致已加密数据无法解密；
// 2) 避免每次加解密都重新读盘。
const keyCache = new Map<string, Promise<Buffer>>();

async function readOrCreateKeyFile(keyFile: string): Promise<Buffer> {
  let encoded: string;
  try {
    encoded = await fs.readFile(keyFile, "utf-8");
  } catch (err) {
    // 只有"文件不存在"才允许走下方生成分支；权限/IO 等其他读取错误必须显式抛出——
    // 吞掉后重新生成会覆盖旧密钥，config.json 里已加密的 apiKey 将永久不可解密
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `主密钥文件读取失败（${keyFile}），已中止以防覆盖旧密钥：${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  const key = Buffer.from(encoded.trim(), "base64");
  // 长度不符即文件损坏：抛错而非重新生成，绝不覆盖旧文件（理由同上）
  if (key.length !== KEY_LEN) {
    throw new Error(
      `主密钥文件损坏（${keyFile}）：base64 解码后为 ${key.length} 字节，应为 ${KEY_LEN} 字节；` +
        `请人工恢复密钥文件，重新生成会使已加密的 apiKey 永久不可解密`,
    );
  }
  return key;
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
    // 失败（读取错误/文件损坏）时剔除缓存项：
    // 缓存住 rejected Promise 会毒化后续所有调用，文件修复后也无从恢复
    cached.catch(() => keyCache.delete(keyFile));
    keyCache.set(keyFile, cached);
  }
  return cached;
}

export async function encrypt(plainText: string): Promise<string> {
  const key = await getOrCreateMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // 密文布局（M49 起只产新布局）：iv(16) + authTag(16) + data。
  // 旧布局另有 16 字节 salt 前缀（未参与 KDF 的死数据），不再生成
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

export async function decrypt(cipherText: string): Promise<string> {
  const key = await getOrCreateMasterKey();
  const combined = Buffer.from(cipherText, "base64");
  // M49 双布局兼容：先按新布局解，GCM authTag 校验失败再按旧布局（跳过
  // 16 字节 salt 前缀）解——authTag 校验天然防误解：布局判错必然 auth
  // 失败（误通过概率 2^-128），不会静默解出错误明文。长度启发式不可行
  // （两布局仅差定长 16 字节前缀，plaintext 长度任意），故用显式两次试解。
  // 存量密文（provider apiKey 等）均为旧布局，必须保持可解
  try {
    return decryptWithLayout(key, combined, 0);
  } catch {
    return decryptWithLayout(key, combined, LEGACY_SALT_LEN);
  }
}

/** 按 saltPrefixLen 前缀偏移解密（0=新布局 iv+tag+data；LEGACY_SALT_LEN=旧布局 salt+iv+tag+data） */
function decryptWithLayout(key: Buffer, combined: Buffer, saltPrefixLen: number): string {
  const iv = combined.subarray(saltPrefixLen, saltPrefixLen + IV_LEN);
  const authTag = combined.subarray(saltPrefixLen + IV_LEN, saltPrefixLen + IV_LEN + AUTH_TAG_LEN);
  const encrypted = combined.subarray(saltPrefixLen + IV_LEN + AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}

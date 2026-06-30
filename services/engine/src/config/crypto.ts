import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./paths.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const SALT_LEN = 16;

async function getOrCreateMasterKey(): Promise<Buffer> {
  const envKey = process.env.CLOUDMIND_MASTER_KEY;
  if (envKey) {
    return crypto.scryptSync(envKey, "cloudmind-zome", KEY_LEN);
  }
  const keyFile = path.join(getDataDir(), ".master-key");
  try {
    const encoded = await fs.readFile(keyFile, "utf-8");
    return Buffer.from(encoded.trim(), "base64");
  } catch {
    const key = crypto.randomBytes(KEY_LEN);
    try {
      await fs.mkdir(getDataDir(), { recursive: true });
      await fs.writeFile(keyFile, key.toString("base64"), { mode: 0o600 });
    } catch {
      // Fallback for platforms where mode is not supported (e.g. Windows).
      await fs.mkdir(getDataDir(), { recursive: true });
      await fs.writeFile(keyFile, key.toString("base64"));
    }
    return key;
  }
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

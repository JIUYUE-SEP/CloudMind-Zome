import { defineEventHandler, setHeader } from "h3";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Web 开发模式 engine token 自动分发（零配置）。
 *
 * 背景：web 开发下 engine REST/WS 全部要求 Bearer token，此前只能手动配
 * NUXT_PUBLIC_ENGINE_TOKEN 或 localStorage["cloudmind.engineToken"]，指挥官
 * 打开即 401，进门体验断裂。nitro dev server 与 engine 同机，启动/请求时读
 * engine 的 auth-token 文件，经 /api/engine-token 在运行时下发给浏览器。
 *
 * 安全：token 是机密——只走 localhost 开发场景；运行时下发而非构建时内联，
 * token 不进客户端 bundle。生产/静态构建由 import.meta.dev 门禁直接返回空。
 */

/** engine 数据目录解析与 services/engine/src/config/paths.ts getDataDir() 同口径 */
export function getEngineTokenFilePath(): string {
  const dataDir =
    process.env.CLOUDMIND_DATA_DIR || path.join(os.homedir(), ".cloudmind-zome");
  return path.join(dataDir, "auth-token");
}

/**
 * 读 engine auth-token 文件。文件不存在/不可读/内容为空一律返回空串——
 * 前端拿不到 token 时优雅降级为既有 401/4401 提示，不崩。
 */
export async function readEngineAuthToken(): Promise<string> {
  try {
    return (await fsp.readFile(getEngineTokenFilePath(), "utf-8")).trim();
  } catch {
    return "";
  }
}

export default defineEventHandler(async (event) => {
  // 仅 nitro dev（localhost 开发场景）下发；生产/静态构建不暴露 token
  if (!import.meta.dev) {
    return { token: "" };
  }
  // token 是机密：禁止浏览器/中间层缓存响应
  setHeader(event, "Cache-Control", "no-store");
  return { token: await readEngineAuthToken() };
});

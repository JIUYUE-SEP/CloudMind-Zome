import { defineEventHandler, getQuery, setHeader, setResponseStatus, sendStream } from "h3";
import { Readable } from "node:stream";
import { useRuntimeConfig } from "#imports";
import { readEngineAuthToken } from "./engine-token";

/**
 * agent 文件代理（generate_image 出图链路）：GET /api/agent-file?agentId=..&path=..
 *
 * 背景：engine REST 全局 Bearer 鉴权，<img> 标签无法带 header——由 nitro 服务端
 * 带 token 转发 engine 的 GET /agents/:id/files/*，流式回传 content-type 与 body；
 * token 只进服务端内存，不出现在客户端 bundle / URL / 响应里。
 *
 * 路径双闸：本层先做词法校验（拒绝对路径/反斜杠/.. 段），engine 路由侧还有
 * resolve+前缀校验兜底（穿越 400）。
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const agentId = typeof query.agentId === "string" ? query.agentId : "";
  const filePath = typeof query.path === "string" ? query.path : "";
  if (!agentId || !filePath) {
    setResponseStatus(event, 400);
    return { error: "agentId and path are required" };
  }
  const segments = filePath.split("/");
  if (
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    segments.some((s) => s === ".." || s === "")
  ) {
    setResponseStatus(event, 400);
    return { error: "invalid path" };
  }
  // 契约：query.path 是工作区相对路径（含 files/ 前缀，generate_image 输出形态
  // files/images/...），engine 端点的通配段是 files/ 子树相对路径——剥掉一个
  // files/ 前缀再转发，否则拼出 files/files/... 必然 404（生图 e2e 翻案单实证）
  if (segments[0] === "files") segments.shift();
  if (segments.length === 0) {
    setResponseStatus(event, 400);
    return { error: "invalid path" };
  }

  const config = useRuntimeConfig(event);
  const engineUrl = String(config.public.engineUrl).replace(/\/+$/, "");
  // token 优先级与客户端同口径：显式配置（ENGINE_TOKEN）→ auth-token 文件
  const token = String(config.public.engineToken || "") || (await readEngineAuthToken());

  const upstream = await fetch(
    `${engineUrl}/agents/${encodeURIComponent(agentId)}/files/${segments.map(encodeURIComponent).join("/")}`,
    token ? { headers: { authorization: `Bearer ${token}` } } : {},
  );

  // 状态码/content-type/content-length 原样透传（含 400/404/415 错误与 200 图片）
  setResponseStatus(event, upstream.status);
  const contentType = upstream.headers.get("content-type");
  if (contentType) setHeader(event, "content-type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) setHeader(event, "content-length", Number(contentLength));
  if (!upstream.body) return "";
  return sendStream(
    event,
    Readable.fromWeb(upstream.body as unknown as import("stream/web").ReadableStream),
  );
});

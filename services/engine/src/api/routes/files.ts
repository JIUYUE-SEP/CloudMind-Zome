import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { isValidAgentId } from "@cloudmind/shared";
import { getAgentDir } from "../../config/paths.js";
import type { ApiContext } from "../context.js";

/** 扩展名 → content-type 白名单（决策 7：只读图片最小面，其余 415） */
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * agent 文件服务（决策 7 最小面）：GET /agents/:id/files/* ——
 * 只读、仅限 files/ 子树、resolve 后前缀校验防 `..` 穿越、content-type
 * 按扩展名白名单、不列目录、读流回包（不引 @fastify/static，决策 4）。
 * generate_image 落盘产物经此端点供 web 代理取图。
 */
export async function registerFileRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/agents/:id/files/*", {
    schema: { summary: "Read a file under the agent's files/ subtree (image whitelist only)", tags: ["agents"] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const wildcard = (request.params as Record<string, string>)["*"] ?? "";

    if (!isValidAgentId(id)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const config = await context.agentRepository.get(id);
    if (!config) return reply.status(404).send({ error: "Agent not found" });

    // 路径解析：resolve 后必须落在 files/ 子树内（防 .. 穿越；穿越 400）
    const filesRoot = path.resolve(getAgentDir(id), "files");
    const fullPath = path.resolve(filesRoot, wildcard);
    if (fullPath !== filesRoot && !fullPath.startsWith(filesRoot + path.sep)) {
      return reply.status(400).send({ error: "Path traversal is not allowed" });
    }

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.status(404).send({ error: "File not found" });
      }
      throw err;
    }
    // 不列目录：目录请求一律 400（含 files/ 根）
    if (stat.isDirectory()) {
      return reply.status(400).send({ error: "Directory listing is not allowed" });
    }

    const contentType = EXT_TO_CONTENT_TYPE[path.extname(fullPath).toLowerCase()];
    if (!contentType) {
      return reply.status(415).send({ error: "Unsupported media type (whitelist: png/jpeg/webp/gif)" });
    }

    return reply
      .type(contentType)
      .header("content-length", String(stat.size))
      .send(createReadStream(fullPath));
  });
}

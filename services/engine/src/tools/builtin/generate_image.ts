import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logger } from "../../logger.js";
import { renameWithRetry } from "../../plugins/memory/document-store.js";
import { IMAGE_GENERATE_TIMEOUT_MS } from "../../provider/image-gen.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 隐私口径（决策 8，沿用 §8.1）：prompt 等原始文本进日志/落档一律截 500 */
const PROMPT_MAX_CHARS = 500;

/** content-type 白名单 → 扩展名（决策 3：png/jpeg/webp/gif，与阶段 2 文件服务白名单同套） */
const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const parameters = z.object({
  prompt: z.string().min(1).max(4000).describe("生图提示词（1-4000 字符）"),
  size: z
    .enum(["1024x1024", "1792x1024", "1024x1792"])
    .optional()
    .describe("图片尺寸（缺省不传，由 provider 默认决定）"),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("可选：临时覆盖生图型号（缺省用 agent 配置的 imageModelId / provider 默认型号）"),
});

type ParsedArgs = z.infer<typeof parameters>;

interface PersistedImage {
  buffer: Buffer;
  ext: string;
}

function truncatePrompt(text: string): string {
  return text.length <= PROMPT_MAX_CHARS ? text : `${text.slice(0, PROMPT_MAX_CHARS)}…`;
}

/** 防泄漏：超长 prompt 原文出现在错误文本里时，替换为截断形态（决策 8） */
function sanitizePromptLeak(text: string, prompt: string): string {
  if (prompt.length <= PROMPT_MAX_CHARS || !text.includes(prompt)) return text;
  return text.split(prompt).join(truncatePrompt(prompt));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** data-url / 裸 base64 → 字节 + 扩展名；类型不在白名单返回结构化错误 */
function decodeData(data: string): PersistedImage | ToolResult {
  if (data.startsWith("data:")) {
    const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(data);
    if (!match) {
      return { success: false, error: "generate_image 返回的 data-url 格式无法解析" };
    }
    const mime = (match[1] ?? "").toLowerCase();
    const ext = CONTENT_TYPE_TO_EXT[mime];
    if (!ext) {
      return {
        success: false,
        error: `generate_image 返回的图片类型不在白名单（${mime || "未声明"}），仅支持 png/jpeg/webp/gif`,
      };
    }
    try {
      const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
      return { buffer, ext };
    } catch (err) {
      return { success: false, error: `generate_image 返回的 data-url 解码失败：${String(err)}` };
    }
  }
  // 裸 base64：无类型信息，按 png 落盘（决策 3：data 直接写盘）
  try {
    return { buffer: Buffer.from(data, "base64"), ext: "png" };
  } catch (err) {
    return { success: false, error: `generate_image 返回的 base64 数据解码失败：${String(err)}` };
  }
}

/** 落盘：files/images/<yyyyMMdd-HHmmss>-<6随机>.<ext>，原子写 tmp+rename（沿用 document-store 纪律） */
async function persistImage(workspaceDir: string, image: PersistedImage): Promise<string> {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const filename = `${stamp}-${randomBytes(3).toString("hex")}.${image.ext}`;
  const imagesDir = path.join(workspaceDir, "files", "images");
  await fs.mkdir(imagesDir, { recursive: true });
  const fullPath = path.join(imagesDir, filename);
  const tmpPath = `${fullPath}.tmp`;
  await fs.writeFile(tmpPath, image.buffer);
  await renameWithRetry(tmpPath, fullPath);
  return `files/images/${filename}`;
}

/** 下载 url → 字节；任何失败（超时/非 2xx/超限/类型白名单外/网络错误）throw，由调用方回退 */
async function downloadImage(url: string): Promise<PersistedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = CONTENT_TYPE_TO_EXT[contentType];
    if (!ext) {
      throw new Error(`content-type 不在白名单（${contentType || "未声明"}）`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_IMAGE_BYTES) {
      throw new Error(`图片体积超限（${declaredLength} > ${MAX_IMAGE_BYTES} 字节）`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`图片体积超限（>${MAX_IMAGE_BYTES} 字节）`);
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`图片体积超限（${buf.byteLength} > ${MAX_IMAGE_BYTES} 字节）`);
      }
      chunks.push(buf);
    }
    return { buffer: Buffer.concat(chunks), ext };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * generate_image（出网 + 计费工具，默认需人工审批；不在 NO_REMEMBER_TOOLS
 * 五高危名单内，允许「本会话免问」，与 web_search 同档——决策 2）。
 * 结果落盘优先（决策 3）：provider 返回 url 下载落盘（15s 超时 / 20MB 上限 /
 * content-type 白名单），返回 data/data-url 直接解码写盘；下载失败回退
 * persisted:false + sourceUrl，不吞不崩。未配置生图 provider 的 agent 调用
 * 返回配置指引错误（决策 5）。
 */
export const generateImageTool: Tool = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt via the configured image provider, " +
    "then persist it under files/images/ (url results are downloaded with a 15s timeout, " +
    "20MB cap, png/jpeg/webp/gif whitelist; data/base64 results are decoded and written directly). " +
    "Falls back to persisted:false + sourceUrl when the download fails. " +
    "Requires the agent to have an image provider configured; network access needs approval.",
  parameters,
  accesses: [
    { resource: "network", action: "read" },
    { resource: "file", action: "write", path: "files/images/" },
  ],
  requiresApproval: true,
  // P1-6：自报执行上限。看门狗据此为本工具放宽停滞阈值（effectiveThresholdMs），
  // 否则生图会被 600s 硬阈值当停滞杀掉。数值与 provider 层 timeout 同源，
  // 改一处即两处同步（IMAGE_GENERATE_TIMEOUT_MS）
  timeoutMs: IMAGE_GENERATE_TIMEOUT_MS,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    let parsed: ParsedArgs;
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    // 决策 5：未配置 imageProviderId 的 agent 不注入 provider，调用返回明确配置指引
    const imageProvider = ctx.services?.imageProvider;
    if (!imageProvider) {
      return {
        success: false,
        error:
          "generate_image 未配置生图 provider（AgentConfig.imageProviderId），" +
          "请在该 agent 的设置中配置生图 provider 后重试",
      };
    }

    let generated: { url?: string; data?: string };
    try {
      generated = await imageProvider.generate(parsed.prompt, { size: parsed.size, model: parsed.model });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `generate_image 生成失败：${sanitizePromptLeak(detail, parsed.prompt)}`,
      };
    }

    const baseOutput = { model: parsed.model, size: parsed.size };

    // data / data-url：直接解码写盘（决策 3）
    if (generated.data) {
      const decoded = decodeData(generated.data);
      if ("success" in decoded) return decoded;
      try {
        const relPath = await persistImage(ctx.workspaceDir, decoded);
        return { success: true, output: { path: relPath, ...baseOutput, persisted: true } };
      } catch (err) {
        return { success: false, error: `generate_image 图片落盘失败：${String(err)}` };
      }
    }

    if (generated.url) {
      try {
        const downloaded = await downloadImage(generated.url);
        const relPath = await persistImage(ctx.workspaceDir, downloaded);
        return { success: true, output: { path: relPath, ...baseOutput, persisted: true } };
      } catch (err) {
        // 决策 3：下载失败回退 persisted:false + sourceUrl（success:true，标注），不吞不崩
        const reason = isAbortError(err)
          ? `下载超时（${DOWNLOAD_TIMEOUT_MS}ms）`
          : err instanceof Error
            ? err.message
            : String(err);
        logger.warn({ agentId: ctx.agentId, reason }, "[generate_image] 图片下载失败，回退返回 sourceUrl");
        return {
          success: true,
          output: {
            ...baseOutput,
            persisted: false,
            sourceUrl: generated.url,
            note: `图片下载失败（${reason}），未落盘；sourceUrl 可能有时效`,
          },
        };
      }
    }

    return {
      success: false,
      error: "generate_image provider 未返回任何图片数据（既无 url 也无 data）",
    };
  },
};

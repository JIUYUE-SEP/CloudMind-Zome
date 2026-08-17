import { z } from "zod";
import type { ChatMessageRecord } from "@mindcloud/shared";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { intermindSessionId } from "@mindcloud/shared";

const READ_PRIVATE_MESSAGES_DEFAULT_LIMIT = 50;
const READ_PRIVATE_MESSAGES_MAX_LIMIT = 200;

const parameters = z.object({
  from: z.string().min(1).describe("对端 Agent id（读与 ta 的 intermind:<from> 来往信件）"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(READ_PRIVATE_MESSAGES_MAX_LIMIT)
    .optional()
    .describe(
      `读取条数上限（缺省 ${READ_PRIVATE_MESSAGES_DEFAULT_LIMIT}，上限 ${READ_PRIVATE_MESSAGES_MAX_LIMIT}）`,
    ),
  // M36：before 游标透传 service.listMessages（跨热存储+归档，H8 已修），
  // 超长线程逐页向前翻，「读完整来信」不再封顶 200
  before: z
    .string()
    .min(1)
    .optional()
    .describe("向前翻页游标：传本页最旧一封的消息 id，读它之前的更早来往信件"),
});

function fullText(record: ChatMessageRecord): string {
  return record.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Intermind 读全文工具（二期 P2-4）：
 * 感知通知只带 200 字摘要，长信后半接收方读不到——从本 agent 的
 * `intermind:<from>` 会话读完整来往信件（含方向/时间/全文），不受摘要截断影响。
 * 超长线程用 before 游标逐页向前翻（跨热存储+归档，历史完整可读，M36），
 * 输出尾部带翻页指引（recall 工具同风格）。
 * 免审批（读自己的信，非危险操作），但需 agent 白名单显式授权；傀儡上下文硬拒。
 */
export const readPrivateMessagesTool: Tool = {
  name: "read_private_messages",
  description:
    "读自己与另一个 Agent 的完整来往私信（Intermind 收信箱）：从本 agent 的 " +
    "intermind:<from> 会话取全文，含方向/时间/正文，不受感知通知 200 字摘要截断影响；" +
    "超长线程用 before 游标（本页最旧一封的 id）逐页向前翻，更早历史完整可读。 " +
    "免审批但需工具白名单授权；傀儡分身没有社交权，不可用；对端无会话时返回空列表。",
  parameters,
  accesses: [{ resource: "memory", action: "read" }],
  requiresApproval: false,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    if (ctx.isPuppet === true) {
      return { success: false, error: "傀儡无社交权：read_private_messages 对 puppet 上下文不可用" };
    }
    const service = ctx.services?.intermindService;
    if (!service) {
      return { success: false, error: "Intermind service not available" };
    }

    let parsed: z.infer<typeof parameters>;
    try {
      parsed = parameters.parse(args);
    } catch (err) {
      return { success: false, error: String(err) };
    }

    try {
      const limit = parsed.limit ?? READ_PRIVATE_MESSAGES_DEFAULT_LIMIT;
      const messages = await service.listMessages(ctx.agentId, parsed.from, {
        limit,
        ...(parsed.before !== undefined ? { before: parsed.before } : {}),
      });
      // 翻页指引（M36，recall 同风格 hint 字段）：满页 = 可能还有更早的信，
      // 游标取本页最旧一封（listMessages 返回按时间正序，首条最旧）
      const hint =
        messages.length === 0
          ? `没有与 ${parsed.from} 的来往私信`
          : messages.length < limit
            ? `这是与 ${parsed.from} 的来往私信，共 ${messages.length} 封，已读到最早`
            : `本次按上限返回最近 ${limit} 封，可能还有更早的信——再调用本工具并传 before: "${messages[0]!.id}" 向前翻页`;
      return {
        success: true,
        output: {
          from: parsed.from,
          sessionId: intermindSessionId(parsed.from),
          count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            direction: m.agentId === ctx.agentId ? "sent" : "received",
            from: m.agentId,
            to: m.agentId === ctx.agentId ? parsed.from : ctx.agentId,
            createdAt: m.createdAt,
            text: fullText(m),
          })),
          hint,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};

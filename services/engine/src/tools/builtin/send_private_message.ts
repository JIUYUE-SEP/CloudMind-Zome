import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const PRIVATE_MESSAGE_MAX_CHARS = 10_000;

const parameters = z.object({
  to: z.string().min(1).describe("目标 Agent id（接收方人形）"),
  content: z
    .string()
    .min(1)
    .max(PRIVATE_MESSAGE_MAX_CHARS)
    .describe("私信内容"),
});

/**
 * Intermind 人形间私信（一期）：
 * 写信型 + 唤醒混合——信写入双方 intermind 会话并触发接收方一轮感知回合；
 * 感知回合内回信自动搭车（只入队、不再次唤醒对方）。
 * 免审批（社交动作非危险操作），但需 agent 白名单显式授权；傀儡上下文硬拒。
 */
export const sendPrivateMessageTool: Tool = {
  name: "send_private_message",
  description:
    "给另一个 Agent 写信（Intermind 人形间私信）：信进入对方与自己的 intermind 会话，" +
    "并触发对方一轮感知回合读信；感知回合里她的回信自动搭车（只入队不再次唤醒），" +
    "不会连环惊醒。免审批但需工具白名单授权；傀儡分身没有社交权，不可用。",
  parameters,
  accesses: [{ resource: "memory", action: "write" }],
  requiresApproval: false,
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    if (ctx.isPuppet === true) {
      return { success: false, error: "傀儡无社交权：send_private_message 对 puppet 上下文不可用" };
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
      // 搭车：私信唤醒回合（intermindRide）内回信只入队，不再次唤醒对方
      const result = await service.send(ctx.agentId, parsed.to, parsed.content, {
        wake: ctx.intermindRide !== true,
      });
      return {
        success: true,
        output: {
          messageId: result.messageId,
          recipientSessionId: result.recipientSessionId,
          woke: result.woke,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
};

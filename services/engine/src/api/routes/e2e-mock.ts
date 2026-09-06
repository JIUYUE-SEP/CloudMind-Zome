import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { isValidAgentId } from "@cloudmind/shared";
import { MockLLMProvider } from "../../provider/llm.js";
import type { ApiContext } from "../context.js";

const bodySchema = z.object({
  agentId: z.string().min(1),
  toolCalls: z
    .array(
      z.object({
        toolCallId: z.string().min(1),
        name: z.string().min(1),
        arguments: z.unknown(),
      }),
    )
    .min(1),
});

/**
 * 包装链钻取（生产真形状：agents 装配链 = ResilientLLMProvider(
 * withLLMCallRecording(MockLLMProvider) )）——resilient 的 current/primary
 * 是运行时私有字段（runtime 可见），record-calls 包装经 additive 的 inner 暴露。
 */
function findMockProvider(provider: unknown): MockLLMProvider | undefined {
  let cur = provider as { current?: unknown; primary?: unknown; inner?: unknown } | undefined;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof MockLLMProvider) return cur;
    cur = (cur.current ?? cur.primary ?? cur.inner) as typeof cur;
  }
  return undefined;
}

/**
 * e2e 限定注入端点（plan 决策 1）：**仅 NODE_ENV=e2e 注册**（server.ts 注册处
 * 环境判定，生产构建路径零存在）；handler 内环境再查一次（防线分离）。
 * 给指定 agent worker 的 MockLLMProvider 注入下一次 chat 要发的 tool calls
 * （provider/llm.ts setNextToolCalls 既有语义）。非 Mock provider（生产链路
 * 误入）fail-closed 明确错误，不静默。
 */
export async function registerE2eMockRoutes(app: FastifyInstance, context: ApiContext) {
  app.post("/e2e/mock/tool-calls", {
    schema: { summary: "[e2e only] Inject tool calls into an agent's Mock provider", tags: ["e2e"] },
  }, async (request, reply) => {
    // 防线分离：注册处判定之外 handler 再查一次（直接挂路由的测试/自定义装配也罩住）
    if (process.env.NODE_ENV !== "e2e") {
      return reply.status(404).send({ error: "Not found" });
    }
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: String(err) });
    }
    if (!isValidAgentId(body.agentId)) {
      return reply.status(400).send({ error: "Invalid agent id" });
    }
    const worker = await context.getAgentWorker(body.agentId);
    if (!worker) {
      return reply.status(404).send({ error: "Agent not found（或 worker 未创建——先建立会话）" });
    }
    const mock = findMockProvider(
      (worker as unknown as { config: { provider: unknown } }).config.provider,
    );
    if (!mock) {
      return reply.status(409).send({
        error: "当前 agent 的 provider 不是 MockLLMProvider，无法注入 tool calls（fail-closed）",
      });
    }
    // zod 的 z.unknown() 在输出类型里键位可选，Mock 签名要求必带——形状一致仅
    // 键位可选性差异，此处显式收窄
    mock.setNextToolCalls(
      body.toolCalls as Array<{ toolCallId: string; name: string; arguments: unknown }>,
    );
    return { ok: true, count: body.toolCalls.length };
  });
}

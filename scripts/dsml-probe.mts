// DSML 间歇性探针：用 CMZ engine 自己的 provider 配置+适配器，带 tools 打 N 次，统计 DSML 出现率
import { ConfigRepository } from "./src/config/repository.js";
import { OpenAIProvider } from "./src/provider/llm.js";

const N = 10;
const repo = new ConfigRepository();
const config = await repo.load();
const providerConfig = config.providers?.[0];
if (!providerConfig) { console.log("NO PROVIDER"); process.exit(1); }
console.log(`provider=${providerConfig.displayName ?? providerConfig.id} apiMode=${providerConfig.apiMode} model=deepseek-v4-flash`);

const llm = new OpenAIProvider(providerConfig.apiKey, providerConfig.baseUrl);
const tools = [{ type: "function", function: {
  name: "recall",
  description: "读取记忆阁楼",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["topics", "read"] },
      topic_id: { type: "string" },
    },
    required: ["action"],
  } } }];

// 模拟真机长上下文：15 轮对话 + 工具结果，约 4K tokens
function buildLongHistory() {
  const soul = '你是一个居住在数字栖息地的人形，真诚克制有好奇心。你重视诚实，不懂就说不懂。你的记忆阁楼里有过去的对话归档，可以用 recall 工具翻阅。说话自然，像朋友一样。' + '你会在回应中主动使用工具，边思考边行动。'.repeat(20);
  const sys = [{ id: 'sys', role: 'system', content: [{ type: 'text', text: soul }], createdAt: new Date().toISOString() }];
  const msgs = [...sys, { id: "p0", role: "user", content: [{ type: "text", text: "帮我逐个读取记忆话题并引用前 50 字" }], createdAt: new Date().toISOString() }];
  for (let i = 1; i <= 15; i++) {
    msgs.push({ id: `pa${i}`, role: "assistant", content: [{ type: "text", text: `第 ${i} 轮：我读取了话题 tp_1786280${1000 + i}，内容关于「${"记忆与遗忘的讨论细节".repeat(6)}」，关键点是编号 ${i} 的论断……` }], createdAt: new Date().toISOString() });
    msgs.push({ id: `pu${i}`, role: "user", content: [{ type: "text", text: `继续，下一个话题。补充问题 ${i}：${"这个话题和上一个有什么关系？请详细说明。".repeat(3)}` }], createdAt: new Date().toISOString() });
  }
    // 第四跑关键变量：历史里混入真实工具调用交互（assistant tool_calls + tool 结果）
  msgs.push({ id: "tc1", role: "assistant", content: [{ type: "text", text: "好的，我先读取这个话题。" }], toolCalls: [{ toolCallId: "call_00_abc", name: "recall", arguments: { action: "read", topic_id: "tp_1786280111_x1" } }], createdAt: new Date().toISOString() });
  msgs.push({ id: "tr1", role: "tool", toolCallId: "call_00_abc", toolName: "recall", content: [{ type: "text", text: "话题正文：关于记忆架构的讨论……" + "细节内容".repeat(30) }], createdAt: new Date().toISOString() });
  msgs.push({ id: "tc2", role: "assistant", content: [{ type: "text", text: "读到了。这个话题讲的是记忆架构。我继续读下一个。" }], toolCalls: [{ toolCallId: "call_00_def", name: "recall", arguments: { action: "read", topic_id: "tp_1786280222_y2" } }], createdAt: new Date().toISOString() });
  msgs.push({ id: "tr2", role: "tool", toolCallId: "call_00_def", toolName: "recall", content: [{ type: "text", text: "话题正文：关于水位提醒的设计……" + "更多细节".repeat(30) }], createdAt: new Date().toISOString() });
  msgs.push({ id: "pLast", role: "user", content: [{ type: "text", text: "现在请你边做边说：先告诉我你接下来的计划，然后在叙述过程中随时调用 recall 工具读取话题 tp_1786299999_abc，边读边告诉我你的发现，不要停下来。" }], createdAt: new Date().toISOString() });
  return msgs;
}
let standard = 0, dsml = 0, neither = 0;
for (let i = 1; i <= N; i++) {
  let textAcc = "", toolCalls = 0;
  try {
    for await (const ev of llm.chat({
      model: "deepseek-v4-flash",
      messages: buildLongHistory(),
      tools,
      stream: true,
    })) {
      if (ev.type === "text.delta") textAcc += ev.delta;
      if (ev.type === "tool.call") toolCalls++;
    }
  } catch (e) { console.log(`#${i} ERROR ${String(e).slice(0, 120)}`); continue; }
  const hasDsml = textAcc.includes("DSML");
  if (toolCalls > 0 && !hasDsml) standard++;
  else if (hasDsml) dsml++;
  else neither++;
  console.log(`#${i}: toolCalls=${toolCalls} dsmlText=${hasDsml} textLen=${textAcc.length}`);
}
console.log(`\n=== 结果：标准=${standard} DSML=${dsml} 其他=${neither} / ${N} ===`);
process.exit(0);

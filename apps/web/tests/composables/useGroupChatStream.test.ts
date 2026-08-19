import { describe, it, expect, vi } from "vitest";
import { useGroupChatStream } from "@/composables/useGroupChatStream";

describe("useGroupChatStream", () => {
  it("两个 Agent 的并发流式增量进各自气泡，互不交错", () => {
    const { messages, handlers } = useGroupChatStream();

    handlers.onTextDelta("你", "a1");
    handlers.onTextDelta("我", "a2");
    handlers.onTextDelta("好", "a1");
    handlers.onTextDelta("们", "a2");

    expect(messages.value).toHaveLength(2);
    const [m1, m2] = messages.value;
    expect(m1!.agentId).toBe("a1");
    expect(m1!.text).toBe("你好");
    expect(m2!.agentId).toBe("a2");
    expect(m2!.text).toBe("我们");
  });

  it("thinking.delta 也会建立气泡并累积思考内容", () => {
    const { messages, handlers } = useGroupChatStream();
    handlers.onThinkingDelta("想一", "a1");
    handlers.onThinkingDelta("想二", "a1");
    handlers.onTextDelta("答", "a1");

    expect(messages.value).toHaveLength(1);
    expect(messages.value[0]!.thinking).toBe("想一想二");
    expect(messages.value[0]!.text).toBe("答");
  });

  it("tool.call 路由到对应 Agent 的气泡", () => {
    const { messages, handlers } = useGroupChatStream();
    handlers.onTextDelta("查一下", "a1");
    handlers.onTextDelta("稍等", "a2");
    handlers.onToolCall({ toolCallId: "t1", name: "search", arguments: {}, agentId: "a2" });

    expect(messages.value[0]!.toolCalls).toHaveLength(0);
    expect(messages.value[1]!.toolCalls).toHaveLength(1);
    expect(messages.value[1]!.toolCalls[0]!.toolCallId).toBe("t1");
  });

  it("turn.end 只关闭对应 Agent 的槽，同一 turn 的多步进同一气泡", () => {
    const { messages, isStreaming, handlers } = useGroupChatStream();
    handlers.onTextDelta("A", "a1");
    handlers.onTextDelta("B", "a2");
    expect(isStreaming.value).toBe(true);

    // a1 工具调用后继续输出：仍进 a1 的同一气泡，不开新气泡
    handlers.onToolCall({ toolCallId: "t1", name: "search", arguments: {}, agentId: "a1" });
    handlers.onTextDelta("继续", "a1");
    expect(messages.value).toHaveLength(2);
    expect(messages.value[0]!.text).toBe("A继续");
    expect(messages.value[0]!.toolCalls).toHaveLength(1);

    handlers.onTurnEnd("a1");
    expect(messages.value[0]!.isStreaming).toBe(false);
    expect(messages.value[1]!.isStreaming).toBe(true);
    expect(isStreaming.value).toBe(true);

    // a1 下一轮的发言开新气泡
    handlers.onTextDelta("A2", "a1");
    expect(messages.value).toHaveLength(3);
    expect(messages.value[2]!.text).toBe("A2");

    handlers.onTurnEnd("a2");
    handlers.onTurnEnd("a1");
    expect(isStreaming.value).toBe(false);
  });

  it("非 string 的 delta 帧丢弃并 warn，不建槽（与私聊同口径防御）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { messages, isStreaming, handlers } = useGroupChatStream();
      handlers.onTextDelta(123 as unknown as string, "a1");
      handlers.onThinkingDelta(null as unknown as string, "a1");
      expect(messages.value).toHaveLength(0);
      expect(isStreaming.value).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("onError 关闭所有槽并追加错误气泡", () => {
    const { messages, isStreaming, handlers } = useGroupChatStream();
    handlers.onTextDelta("A", "a1");
    handlers.onTextDelta("B", "a2");

    handlers.onError("boom");
    expect(isStreaming.value).toBe(false);
    expect(messages.value[0]!.isStreaming).toBe(false);
    expect(messages.value[1]!.isStreaming).toBe(false);
    expect(messages.value[2]!.text).toBe("Error: boom");
  });

  it("resetStreamState 关闭所有槽", () => {
    const { messages, isStreaming, handlers, resetStreamState } = useGroupChatStream();
    handlers.onTextDelta("A", "a1");
    resetStreamState();
    expect(isStreaming.value).toBe(false);
    expect(messages.value[0]!.isStreaming).toBe(false);
  });

  it("审批请求更新工具状态并追加审批卡片", () => {
    const { messages, handlers } = useGroupChatStream();
    handlers.onToolCall({ toolCallId: "t1", name: "run_command", arguments: {}, agentId: "a1" });
    handlers.onApprovalRequest({
      approvalId: "ap1",
      toolCallId: "t1",
      toolName: "run_command",
      arguments: {},
      agentId: "a1",
    });

    const approvalMsg = messages.value.find((m) => m.approval);
    expect(approvalMsg?.approval?.status).toBe("pending");
    expect(approvalMsg?.approval?.agentId).toBe("a1");
    expect(messages.value[0]!.toolCalls[0]!.status).toBe("awaiting-approval");
  });

  it("pushUserMessage 上屏并锁定输入", () => {
    const { messages, isStreaming, pushUserMessage } = useGroupChatStream();
    pushUserMessage("大家好");
    expect(isStreaming.value).toBe(true);
    expect(messages.value[0]!.role).toBe("user");
    expect(messages.value[0]!.text).toBe("大家好");
  });
});


describe("useGroupChatStream 历史翻页（F3）", () => {
  const record = (id: string, agentId?: string) => ({
    id,
    sessionId: "s1",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `文本 ${id}` }],
    createdAt: "2026-07-21T00:00:00.000Z",
    ...(agentId ? { agentId } : {}),
  });

  const fullPage = () => Array.from({ length: 100 }, (_, i) => record(`m${i + 3}`));

  it("applyHistoryPage 整页落地：满页 → 还有更早，短页 → 没有更早", () => {
    const { messages, hasMoreHistory, applyHistoryPage } = useGroupChatStream();
    applyHistoryPage(fullPage());
    expect(messages.value).toHaveLength(100);
    expect(hasMoreHistory.value).toBe(true);

    applyHistoryPage([record("a"), record("b")]);
    expect(messages.value).toHaveLength(2);
    expect(hasMoreHistory.value).toBe(false);
  });

  it("loadOlderHistory 前置合并更旧一页：升序保持、agentId 归属不丢", async () => {
    const { messages, hasMoreHistory, applyHistoryPage, loadOlderHistory } = useGroupChatStream();
    applyHistoryPage(fullPage());
    expect(hasMoreHistory.value).toBe(true);

    const prepended = await loadOlderHistory(async (before) => {
      // 游标 = 首载最早一条记录的 id
      expect(before).toBe("m3");
      return [record("m1", "a1"), record("m2", "a2")];
    });
    expect(prepended).toBe(2);
    expect(messages.value).toHaveLength(102);
    expect(messages.value[0]).toMatchObject({ id: "m1", agentId: "a1" });
    expect(messages.value[1]).toMatchObject({ id: "m2", agentId: "a2" });
    // 短页 → 没有更早
    expect(hasMoreHistory.value).toBe(false);
  });

  it("前置页按 id 去重：与现有列表重叠的记录不重复上屏", async () => {
    const { messages, applyHistoryPage, loadOlderHistory } = useGroupChatStream();
    applyHistoryPage(fullPage());
    const prepended = await loadOlderHistory(async () => [record("m1"), record("m3")]);
    expect(prepended).toBe(1); // m3 已存在，被去重
    expect(messages.value[0]!.id).toBe("m1");
    expect(messages.value.filter((m) => m.id === "m3")).toHaveLength(1);
  });

  it("并发翻页被闸住；clearHistory 作废在途翻页（切会话）", async () => {
    const { messages, loadingOlder, hasMoreHistory, applyHistoryPage, clearHistory, loadOlderHistory } =
      useGroupChatStream();
    applyHistoryPage(fullPage());
    let resolvePage!: (value: ReturnType<typeof fullPage>) => void;
    const hanging = () =>
      new Promise<ReturnType<typeof fullPage>>((resolve) => {
        resolvePage = resolve;
      });

    const p1 = loadOlderHistory(hanging);
    expect(loadingOlder.value).toBe(true);
    // 在途时重复调用直接短路
    expect(await loadOlderHistory(hanging)).toBe(0);

    // 切会话：清空并作废在途；迟到的旧页不得落地
    clearHistory();
    expect(hasMoreHistory.value).toBe(false);
    resolvePage([record("m1")]);
    expect(await p1).toBe(0);
    expect(messages.value).toEqual([]);
    expect(loadingOlder.value).toBe(false);
  });

  it("流式槽不受翻页影响：前置合并后尾部槽仍 streaming，后续增量入同一槽", async () => {
    const { messages, isStreaming, handlers, applyHistoryPage, loadOlderHistory } = useGroupChatStream();
    applyHistoryPage(fullPage());
    handlers.onTextDelta("生成中", "a1");
    expect(isStreaming.value).toBe(true);

    const prepended = await loadOlderHistory(async () => [record("m1", "a2"), record("m2", "a2")]);
    expect(prepended).toBe(2);
    const last = messages.value[messages.value.length - 1]!;
    expect(last.isStreaming).toBe(true);
    expect(last.agentId).toBe("a1");
    expect(isStreaming.value).toBe(true);

    handlers.onTextDelta("继续", "a1");
    expect(messages.value[messages.value.length - 1]!.text).toBe("生成中继续");
  });

  it("fetchPage 抛错：保持现状，入口仍可重试", async () => {
    const { messages, hasMoreHistory, loadingOlder, applyHistoryPage, loadOlderHistory } = useGroupChatStream();
    applyHistoryPage(fullPage());
    const prepended = await loadOlderHistory(async () => {
      throw new Error("network");
    });
    expect(prepended).toBe(0);
    expect(loadingOlder.value).toBe(false);
    expect(hasMoreHistory.value).toBe(true);
    expect(messages.value).toHaveLength(100);
  });

  it("没有更早后 loadOlderHistory 短路：不再调用 fetchPage", async () => {
    const { applyHistoryPage, loadOlderHistory } = useGroupChatStream();
    applyHistoryPage([record("m1")]); // 短页首载 → hasMoreHistory=false
    let called = false;
    const prepended = await loadOlderHistory(async () => {
      called = true;
      return [];
    });
    expect(prepended).toBe(0);
    expect(called).toBe(false);
  });
});

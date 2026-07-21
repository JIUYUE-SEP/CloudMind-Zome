import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "@/stores/chat";

function makeRecord(id: string, text: string) {
  return {
    id,
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

function jsonDelayed(body: unknown, ms: number) {
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response),
      ms,
    ),
  );
}

describe("chat store 历史加载竞态", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("后切换的会话优先：先发起的慢加载结果被丢弃", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        // A 的历史慢返回，B 的快返回：模拟快速从 A 切到 B
        return url.includes("/chat/a/")
          ? jsonDelayed([makeRecord("m-a", "A 的历史")], 30)
          : jsonDelayed([makeRecord("m-b", "B 的历史")], 0);
      }) as unknown as typeof fetch,
    );

    const store = useChatStore();
    const p1 = store.loadMessages("a");
    const p2 = store.loadMessages("b");
    await Promise.all([p1, p2]);

    expect(store.messages.map((m) => m.id)).toEqual(["m-b"]);
    expect(store.messages[0]!.text).toBe("B 的历史");
  });

  it("disconnect 后在途加载结果不再落地", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonDelayed([makeRecord("m-a", "A 的历史")], 20)) as unknown as typeof fetch,
    );

    const store = useChatStore();
    const p = store.loadMessages("a");
    store.disconnect();
    await p;

    expect(store.messages).toEqual([]);
  });
});

/**
 * onclose 接线回归（安全/可用性）：
 *
 * 背景 bug —— client-manager 连上后直接 `transport.onclose = 本层处理`，
 * 把 `Client.connect()` 挂上的 SDK 处理链整块覆盖掉。SDK 的 `_onclose` 负责
 * 让在途请求以 ConnectionClosed 立即失败并清空内部状态；被覆盖后，server
 * 崩溃时在途 callTool 只能等调用超时（RequestTimeout，属 McpError），而
 * wrapper 把「服务器已应答」判为不可恢复 → 自愈重连永不触发。
 *
 * 这里钉死两件事：
 * 1) chainOnClose 组合器语义（先旧后新、旧链抛错不阻断本层）；
 * 2) 真实 Client + InMemoryTransport 接线后断连，在途请求立刻以
 *    ConnectionClosed 拒绝（即 SDK 处理链仍在）。
 */
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { chainOnClose } from "../../../src/tools/mcp/client-manager.js";

describe("MCP onclose 组合器", () => {
  it("先执行既有处理链，再执行本层记账", () => {
    const order: string[] = [];
    const composed = chainOnClose(
      () => order.push("sdk"),
      () => order.push("self"),
    );
    composed();
    expect(order).toEqual(["sdk", "self"]);
  });

  it("既有处理链抛错不阻断本层记账（server 崩了状态必须落 unavailable）", () => {
    const next = vi.fn();
    const composed = chainOnClose(() => {
      throw new Error("sdk boom");
    }, next);
    expect(() => composed()).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("无既有处理链时退化为单 handler", () => {
    const next = vi.fn();
    chainOnClose(undefined, next)();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("接线后断连：在途请求以 ConnectionClosed 立即失败（SDK _onclose 未被抹掉）", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "s", version: "1" }, { capabilities: { tools: {} } });
    // 永不返回的工具：模拟「server 已收到请求、响应没回来」的挂起窗口
    server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}));
    const client = new Client({ name: "c", version: "1" }, { capabilities: {} });
    // 先接 server 再接 client：Client.connect 的 initialize 握手要等服务端应答，
    // 反序会在握手处死等（InMemoryTransport 只是把消息排队）
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const selfOnClose = vi.fn();
    clientTransport.onclose = chainOnClose(clientTransport.onclose, selfOnClose);

    // 先发请求再断链：断言的是「断链把在途 promise 立刻拒掉」
    const settled = client.callTool({ name: "hang", arguments: {} }).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 直接触发 onclose = 真实 stdio 断链时 SDK 走的同一条路径
    clientTransport.onclose?.();

    const outcome = await settled;
    expect(outcome.kind).toBe("rejected");
    expect((outcome as { error: { code?: number } }).error.code).toBe(ErrorCode.ConnectionClosed);
    expect(selfOnClose).toHaveBeenCalledTimes(1);
  });
});

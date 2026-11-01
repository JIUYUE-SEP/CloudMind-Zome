import type { HandoffUpdateFrame } from "@cloudmind/shared";
import type { ApprovalRequestPayload } from "@/utils/approval";

// engine WS 连接管理器（D2 收敛：私聊 connect 与会话 connectSession 的连接生命周期单点——
// 建连/重连/退避/4401 重建/token 失效点全部只在这里一份）。useEngineClient 的两个入口
// 只拼 URL 并注入 token 三件套，是薄适配。

export interface WebSocketHandlers {
  onOpen?: () => void;
  // 群聊帧会额外携带 agentId（多 Agent 并发流式靠它分槽）；私聊帧为 undefined
  onTextDelta?: (delta: string, agentId?: string) => void;
  onThinkingDelta?: (delta: string, agentId?: string) => void;
  onToolCall?: (toolCall: { toolCallId: string; name: string; arguments: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; output: unknown }) => void;
  // 危险工具审批请求（群聊帧会额外携带 agentId）
  onApprovalRequest?: (request: ApprovalRequestPayload) => void;
  onStepEnd?: (finishReason?: string, agentId?: string) => void;
  // 一轮生成结束（与 step.end 区分：后者每个 ReAct step 都发）；
  // 输入框锁定等"生成中"状态只应在 turn.end / error / close 时复位
  onTurnEnd?: (agentId?: string, aborted?: { reason?: string }) => void;
  onError?: (error: string) => void;
  onClose?: (code?: number, reason?: string) => void;
  // 异常断开后的自动重连（P0-3）：第 attempt 次重试将在 delayMs 后发起
  onReconnecting?: (attempt: number, delayMs: number) => void;
  // 重连成功（仅断线后的再次 onOpen 触发，首次连接不触发）；调用方应在此拉取状态对齐
  onReconnected?: () => void;
  /** 换班移交状态帧（水位撞顶自动续跑/保险丝/abort 的可见化） */
  onHandoffUpdate?: (update: HandoffUpdateFrame) => void;
}

export interface Connection {
  send(text: string): boolean;
  sendRaw(message: object): boolean;
  close(): void;
}

// token 生命周期三件套（由 useEngineClient 注入，权威实现在 composable 侧）：
// 连接管理器不自己解析 token，只在这三个点上与 token 体系交互
export interface ManagedWsDeps {
  /** 当前鉴权 token（建连时经 Sec-WebSocket-Protocol 子协议传递，不出现在 URL/日志） */
  getToken(): string;
  /** token 就绪 Promise：建连/重建前必须等待，不得带空 token 抢跑（真机 #12） */
  ensureTokenReady(): Promise<string>;
  /** token 失效点（REST 401 / WS 4401 / 构造 SyntaxError）：作废就绪缓存，下次重取 */
  invalidateToken(): void;
}

// engine 主动关闭的业务码：终态（agent/session 不存在、参数非法、Origin 拒绝），
// 重连无意义，直接透传 onClose；4401（token 失效）例外——先重取 token 自动重建一次，
// 仍 4401 才按终态透传（见 onclose）；其余（1006 异常断开等）一律自动重连
const TERMINAL_WS_CLOSE_CODES = new Set([4001, 4002, 4003, 4004, 4401, 4403]);

// WS 断线自动重连（P0-3 D-B2）：指数退避 1s/2s/4s…封顶 30s，永不放弃——
// supervisor 侧同样永不放弃重启 engine，两端合成恢复闭环
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export function createManagedWsConnection(
  url: string,
  handlers: WebSocketHandlers,
  isSession: boolean,
  deps: ManagedWsDeps,
): Connection {
  let socket: WebSocket | null = null;
  let closedByCaller = false;
  let hasConnectedOnce = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // A6：SyntaxError 重取 token 已试过一次——重取后仍非法（如显式配置档）不再无限重试
  let wsTokenRetried = false;
  // M43：4401 自动重建已试过一次——重建后仍 4401（新 token 也不被接受）不再无限循环
  let ws4401Retried = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const open = () => {
    clearReconnectTimer();
    // 浏览器 WS 不能设请求头：token 经 Sec-WebSocket-Protocol 子协议传递（不出现在 URL/日志）
    const token = deps.getToken();
    if (token) {
      try {
        socket = new WebSocket(url, token);
      } catch (err) {
        // A6：构造抛 SyntaxError（token 含非法子协议字符）——残留 localStorage token
        // 不可用：清掉并作废就绪缓存，重取后重试建连，不静默死
        const name = (err as { name?: unknown } | null)?.name;
        if (
          name === "SyntaxError" ||
          (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "SyntaxError")
        ) {
          if (wsTokenRetried) {
            // 重取后的 token 仍非法：不再无限重试，透传错误由界面提示
            handlers.onError?.("WebSocket error");
            return;
          }
          wsTokenRetried = true;
          deps.invalidateToken();
          void deps.ensureTokenReady().then(() => {
            if (!closedByCaller) open();
          });
          return;
        }
        throw err;
      }
    } else {
      socket = new WebSocket(url);
    }

    socket.onopen = () => {
      const isReconnect = hasConnectedOnce;
      hasConnectedOnce = true;
      wsTokenRetried = false;
      ws4401Retried = false;
      reconnectAttempts = 0;
      handlers.onOpen?.();
      // 断线后的重连成功：调用方拉取会话状态对齐（最新消息列表）
      if (isReconnect) handlers.onReconnected?.();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          // 群聊帧透出 agentId；私聊保持单参数调用形态（调用方按 arity 区分）
          case "text.delta":
            if (isSession) handlers.onTextDelta?.(data.delta, data.agentId);
            else handlers.onTextDelta?.(data.delta);
            break;
          case "thinking.delta":
            if (isSession) handlers.onThinkingDelta?.(data.delta, data.agentId);
            else handlers.onThinkingDelta?.(data.delta);
            break;
          case "tool.call":
            handlers.onToolCall?.(data);
            break;
          case "tool.result":
            handlers.onToolResult?.(data);
            break;
          case "tool.approval_request":
            handlers.onApprovalRequest?.(data);
            break;
          case "step.end":
            if (isSession) handlers.onStepEnd?.(data.finishReason, data.agentId);
            else handlers.onStepEnd?.(data.finishReason);
            break;
          case "turn.end": {
            // 2026-11-01 P2：中断结束的终帧带 aborted.reason（正常结束不带该字段，
            // 帧形状不变）。只在有中断信息时才传第二参数——保持既有调用形状，
            // 老调用方与测试无需改动。
            const aborted = data.aborted as { reason?: string } | undefined;
            if (isSession) {
              if (aborted) handlers.onTurnEnd?.(data.agentId, aborted);
              else handlers.onTurnEnd?.(data.agentId);
            } else if (aborted) {
              handlers.onTurnEnd?.(undefined, aborted);
            } else {
              handlers.onTurnEnd?.();
            }
            break;
          }
          case "handoff.update":
            handlers.onHandoffUpdate?.(data);
            break;
          case "error":
            handlers.onError?.(data.error);
            break;
        }
      } catch {
        handlers.onError?.("Invalid message from server");
      }
    };

    // 连接被拒时浏览器先 fire error 再 fire close(1006)：每次失败的重连尝试
    // 都会命中这里，透传会无限刷错误气泡（P0 review 返工）。只在首连第一次
    // 失败透传（一次性提示）；重连进行态由 onReconnecting 统一呈现
    socket.onerror = () => {
      // 只在首次连接的第一次失败透传（onerror 先于 onclose，此时
      // reconnectAttempts 仍为 0）；后续失败尝试由 onReconnecting 呈现
      if (!hasConnectedOnce && reconnectAttempts === 0) {
        handlers.onError?.("WebSocket error");
      }
    };

    socket.onclose = (event) => {
      const code = event?.code;
      // A6/F4：4401（token 失效/轮换）→ 作废就绪缓存 + 清 localStorage，下次建连重取
      if (code === 4401) {
        deps.invalidateToken();
      }
      // M43：4401 不再直接终态——三失效点已作废旧 token，重取后自动重建一次；
      // 重建仍 4401（新 token 也不被接受，如显式配置档错误）才落入终态分支透传，
      // 保持「未连接」由人工恢复，避免无限重建
      if (!closedByCaller && code === 4401 && !ws4401Retried) {
        ws4401Retried = true;
        reconnectAttempts += 1;
        handlers.onReconnecting?.(reconnectAttempts, 0);
        void deps
          .ensureTokenReady()
          .then(() => {
            if (!closedByCaller) open();
          })
          .catch(() => {
            // A4 验证遗留：重取 token 的 Promise reject 此前是 unhandled rejection，
            // 连接悬在既不重建也不透传的中间态——按终态语义透传 onClose，
            // 保持「未连接」由人工恢复（调用方已 close 则不重复透传）
            if (!closedByCaller) handlers.onClose?.(code, event?.reason);
          });
        return;
      }
      // 调用方主动关闭 / 终态业务码：透传，不重连
      if (closedByCaller || (code !== undefined && TERMINAL_WS_CLOSE_CODES.has(code))) {
        handlers.onClose?.(code, event?.reason);
        return;
      }
      reconnectAttempts += 1;
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS,
      );
      handlers.onReconnecting?.(reconnectAttempts, delay);
      reconnectTimer = setTimeout(open, delay);
    };
  };

  // 建连前必须等 token 就绪（真机 #12）：REST 与 WS 都不能带着空 token 抢跑
  // /api/engine-token 的异步解析；就绪 Promise 模块级缓存，只等一次。
  // 重连仍直接 open()——首次建连成功时 token 必然已就绪
  void deps
    .ensureTokenReady()
    .then(() => {
      if (!closedByCaller) open();
    })
    .catch(() => {
      // 与 4401 重建链同口径：初始建连的就绪失败不得 unhandled rejection 或
      // 悬在既不建连也不透传的中间态——透传 onError（与首连 onerror 同一文案），
      // 保持「未连接」由人工恢复
      if (!closedByCaller) handlers.onError?.("WebSocket error");
    });

  const sendRawFrame = (message: object): boolean => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  };

  return {
    send(text: string) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ text }));
        return true;
      }
      return false;
    },
    sendRaw: sendRawFrame,
    close() {
      closedByCaller = true;
      clearReconnectTimer();
      socket?.close();
    },
  };
}

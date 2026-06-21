import { useChatStore } from '@/stores/chat'
import { getWsBase } from '@/api/config'
import { ref } from 'vue'

let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let messageBuffer: string[] = []
const MAX_BUFFER = 200
let reconnectAttempts = 0
const MAX_RECONNECT = 10
let intentionalDisconnect = false

// Close codes that should not trigger automatic reconnection
const NON_RECOVERABLE_CLOSE_CODES = new Set([1000, 1008, 1011])

// ------------------------------------------------------------------
// System log (global, shared with HomeView)
// ------------------------------------------------------------------
export interface LogEntry {
  id: string
  time: string
  type: 'info' | 'warn' | 'error' | 'success'
  source: string
  message: string
}

const MAX_LOGS = 200
export const systemLogs = ref<LogEntry[]>([])

export function pushLog(entry: Omit<LogEntry, 'id' | 'time'>) {
  const now = new Date()
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
  systemLogs.value.push({
    id: `log_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
    time,
    ...entry,
  })
  if (systemLogs.value.length > MAX_LOGS) {
    systemLogs.value = systemLogs.value.slice(-MAX_LOGS)
  }
}

export function useWebSocket() {
  const chat = useChatStore()

  function connect() {
    if (ws && ws.readyState !== WebSocket.CLOSED) return
    intentionalDisconnect = false
    const url = `${getWsBase()}/api/v1/ws`
    ws = new WebSocket(url)

    ws.onopen = () => {
      reconnectAttempts = 0
      startHeartbeat()
      // Flush buffered messages
      while (messageBuffer.length) {
        const m = messageBuffer.shift()
        if (m) ws?.send(m)
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        routeMessage(msg)
      } catch {
        return
      }
    }

    ws.onclose = (event: CloseEvent) => {
      pushLog({ type: 'warn', source: 'WS', message: `连接已断开 (code: ${event.code})` })
      stopHeartbeat()
      if (intentionalDisconnect) return
      if (NON_RECOVERABLE_CLOSE_CODES.has(event.code)) {
        pushLog({ type: 'error', source: 'WS', message: '连接因策略或服务器错误关闭，停止自动重连' })
        return
      }
      if (reconnectAttempts >= MAX_RECONNECT) {
        pushLog({ type: 'error', source: 'WS', message: '重连次数已达上限，请手动刷新页面' })
        return
      }
      scheduleReconnect()
    }

    ws.onerror = () => {
      pushLog({ type: 'error', source: 'WS', message: 'WebSocket 发生错误' })
      // Do not call ws.close() here; let onclose handle cleanup to avoid double scheduling.
    }
  }

  function routeMessage(msg: any) {
    switch (msg.type) {
      case 'auth.success':
        chat.fetchSessions()
        pushLog({ type: 'success', source: 'WS', message: '连接已建立' })
        break
      case 'chat.message': {
        const m = msg.payload?.message
        if (!m) break
        if (msg.payload?.session_id) {
          m.session_id = msg.payload.session_id
        }
        chat.onMessagePush(m)
        break
      }
      case 'chat.typing':
        window.dispatchEvent(new CustomEvent('ws:chat.typing', { detail: msg.payload }))
        break
      case 'chat.thinking':
        window.dispatchEvent(new CustomEvent('ws:chat.thinking', { detail: msg.payload }))
        break
      case 'chat.tool_call':
        window.dispatchEvent(new CustomEvent('ws:chat.tool_call', { detail: msg.payload }))
        break
      case 'action.progress': {
        const p = msg.payload || {}
        const overall = p.overall_progress != null ? `${Math.round(p.overall_progress * 100)}%` : ''
        pushLog({ type: 'info', source: '工作流', message: `节点 ${p.node_id || ''} ${p.node_status || ''} ${overall}` })
        window.dispatchEvent(new CustomEvent('ws:action.progress', { detail: msg }))
        break
      }
      case 'agent.status': {
        const p = msg.payload || {}
        const statusMap: Record<string, string> = { idle: '空闲', busy: '思考中', introspecting: '内省中' }
        pushLog({ type: 'info', source: 'Agent', message: `Agent ${p.agent_id?.slice(0, 6)} 状态 → ${statusMap[p.status] || p.status}` })
        window.dispatchEvent(new CustomEvent('ws:agent.status', { detail: msg.payload }))
        break
      }
      case 'notification.new': {
        const p = msg.payload || {}
        pushLog({ type: 'success', source: '通知', message: `${p.title || '新通知'}: ${p.content || ''}` })
        break
      }
      case 'intermind.start':
        pushLog({ type: 'info', source: '群聊', message: '心智间对话开始' })
        window.dispatchEvent(new CustomEvent('ws:intermind.start', { detail: msg.payload }))
        break
      case 'intermind.end':
        pushLog({ type: 'info', source: '群聊', message: '心智间对话结束' })
        window.dispatchEvent(new CustomEvent('ws:intermind.end', { detail: msg.payload }))
        break
      case 'chat.ack': {
        const p = msg.payload || {}
        window.dispatchEvent(new CustomEvent('ws:chat.ack', { detail: p }))
        break
      }
      case 'pong':
        break
      default:
        console.warn('Unhandled WS:', msg.type)
    }
  }

  function send(obj: object) {
    const text = JSON.stringify(obj)
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(text)
    } else {
      if (messageBuffer.length >= MAX_BUFFER) {
        messageBuffer.shift()
      }
      messageBuffer.push(text)
      if (!ws || ws.readyState === WebSocket.CLOSED) connect()
    }
  }

  function sendChat(sessionId: string, content: string, opts?: { content_type?: string; reply_to?: string; client_msg_id?: string }) {
    send({
      type: 'chat.send',
      payload: {
        session_id: sessionId,
        content,
        content_type: opts?.content_type || 'text',
        reply_to: opts?.reply_to || null,
        client_msg_id: opts?.client_msg_id || `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      }
    })
  }

  function sendTyping(sessionId: string, isTyping: boolean) {
    send({ type: 'chat.typing', payload: { session_id: sessionId, is_typing: isTyping } })
  }

  function sendAgentStop(sessionId: string, agentId: string) {
    send({ type: 'agent.stop', payload: { session_id: sessionId, agent_id: agentId } })
  }

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => send({ type: 'ping' }), 30000)
  }
  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  }
  function scheduleReconnect() {
    reconnectAttempts++
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000)
    reconnectTimer = setTimeout(connect, delay)
  }
  function disconnect() {
    intentionalDisconnect = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopHeartbeat()
    ws?.close()
    ws = null
    pushLog({ type: 'warn', source: 'WS', message: '主动断开连接' })
  }

  return { connect, disconnect, send, sendChat, sendTyping, sendAgentStop }
}

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'

interface Session {
  session_id: string
  type: 'private' | 'group'
  target_id?: string
  target_type?: string
  target_name: string
  target_avatar?: string
  last_message?: { content: string; timestamp: string; is_unread: boolean }
  unread_count: number
  is_pinned?: boolean
}

interface Message {
  id: string
  session_id: string
  sender_id: string
  sender_type: 'user' | 'agent' | 'system'
  sender_name: string
  content: string
  content_type: string
  timestamp: string
  is_me: boolean
  batch_id?: string
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string | null>(null)
  // Use plain object instead of Map for proper Vue reactivity
  const messagesMap = ref<Record<string, Message[]>>({})
  // Unread counts per session
  const unreadMap = ref<Record<string, number>>({})

  const currentMessages = computed(() => {
    if (!currentSessionId.value) return []
    return messagesMap.value[currentSessionId.value] || []
  })

  const totalUnread = computed(() => {
    return Object.values(unreadMap.value).reduce((sum, n) => sum + (n || 0), 0)
  })

  async function fetchSessions() {
    const json = await api.get('/chats/sessions')
    if (json.code === 0) {
      sessions.value = json.data.items
    }
  }

  async function loadMessages(sessionId: string, search?: string) {
    const url = search
      ? `/chats/sessions/${sessionId}/messages?search=${encodeURIComponent(search)}`
      : `/chats/sessions/${sessionId}/messages`
    const json = await api.get(url)
    if (json.code === 0) {
      messagesMap.value[sessionId] = json.data.items || []
    }
  }

  function onMessagePush(msg: Message) {
    const list = messagesMap.value[msg.session_id] || []
    // Deduplicate by id
    if (list.some(m => m.id === msg.id)) return
    const idx = list.findIndex(m => m.batch_id && m.batch_id === msg.batch_id && m.sender_id === msg.sender_id)
    if (idx >= 0 && msg.batch_id) {
      // Append to existing batch
      const updated = [...list]
      updated[idx] = { ...updated[idx], content: updated[idx].content + msg.content }
      messagesMap.value[msg.session_id] = updated
    } else {
      messagesMap.value[msg.session_id] = [...list, msg]
      // Increment unread only for NEW messages (not batch chunks)
      if (msg.session_id !== currentSessionId.value && !msg.is_me) {
        unreadMap.value[msg.session_id] = (unreadMap.value[msg.session_id] || 0) + 1
      }
    }
  }

  function markRead(sessionId: string) {
    unreadMap.value[sessionId] = 0
    const s = sessions.value.find(x => x.session_id === sessionId)
    if (s) s.unread_count = 0
  }

  return { sessions, currentSessionId, messagesMap, unreadMap, currentMessages, totalUnread, fetchSessions, loadMessages, onMessagePush, markRead }
})

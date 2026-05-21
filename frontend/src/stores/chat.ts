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

  const currentMessages = computed(() => {
    if (!currentSessionId.value) return []
    return messagesMap.value[currentSessionId.value] || []
  })

  async function fetchSessions() {
    const json = await api.get('/chats/sessions')
    if (json.code === 0) {
      sessions.value = json.data.items
    }
  }

  async function loadMessages(sessionId: string) {
    const json = await api.get(`/chats/sessions/${sessionId}/messages`)
    if (json.code === 0) {
      messagesMap.value[sessionId] = json.data.items || []
    }
  }

  function onMessagePush(msg: Message) {
    const list = messagesMap.value[msg.session_id] || []
    const idx = list.findIndex(m => m.batch_id && m.batch_id === msg.batch_id && m.sender_id === msg.sender_id)
    if (idx >= 0 && msg.batch_id) {
      // Append to existing batch
      const updated = [...list]
      updated[idx] = { ...updated[idx], content: updated[idx].content + msg.content }
      messagesMap.value[msg.session_id] = updated
    } else {
      messagesMap.value[msg.session_id] = [...list, msg]
    }
  }

  return { sessions, currentSessionId, messagesMap, currentMessages, fetchSessions, loadMessages, onMessagePush }
})

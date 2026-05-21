import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const activeAgentId = ref<string | null>(null)
  const isLoginModalOpen = ref(false)
  const isNotificationOpen = ref(false)
  const isQuickChatOpen = ref(false)
  const isSidePanelOpen = ref(false)
  const pageTransitionLock = ref(false)

  const isAnyOverlayOpen = computed(() =>
    isLoginModalOpen.value || isNotificationOpen.value || isQuickChatOpen.value || isSidePanelOpen.value
  )

  function setActiveAgent(id: string | null) {
    activeAgentId.value = id
  }
  function openLoginModal() { isLoginModalOpen.value = true }
  function closeAllOverlays() {
    isNotificationOpen.value = false
    isQuickChatOpen.value = false
    isSidePanelOpen.value = false
  }

  return {
    activeAgentId, isLoginModalOpen, isNotificationOpen,
    isQuickChatOpen, isSidePanelOpen, pageTransitionLock, isAnyOverlayOpen,
    setActiveAgent, openLoginModal, closeAllOverlays
  }
})

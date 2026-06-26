<template>
  <div class="session-detail-page">
    <GroupChatView
      :session="session"
      :messages="messages"
      :agents="agents.list"
      :is-connected="isConnected"
      :is-streaming="isStreaming"
      @send="onSend"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useRoute } from "vue-router";
import { useSessionsStore } from "@/stores/sessions";
import { useAgentsStore } from "@/stores/agents";
import { useEngineClient, type ChatMessageRecord } from "@/composables/useEngineClient";
import type { Session } from "@/composables/useEngineClient";
import type { DisplayMessage } from "@/components/GroupChatView.vue";

const route = useRoute();
const sessions = useSessionsStore();
const agents = useAgentsStore();
const client = useEngineClient();
const sessionId = computed(() => route.params.id as string);
const session = ref<Session | undefined>(undefined);
const messages = ref<DisplayMessage[]>([]);
const isConnected = ref(false);
const isStreaming = ref(false);
let connection: ReturnType<typeof client.connectSession> | null = null;

onMounted(async () => {
  await sessions.load();
  await agents.load();
  session.value = sessions.sessions.find((s) => s.id === sessionId.value);
  await loadMessages();
  connect();
});

onUnmounted(() => {
  connection?.close();
});

async function loadMessages() {
  const records = await client.getSessionMessages(sessionId.value, 100);
  messages.value = recordsToDisplay(records);
}

function connect() {
  if (connection) connection.close();
  isConnected.value = false;
  isStreaming.value = false;

  connection = client.connectSession(sessionId.value, {
    onOpen: () => {
      isConnected.value = true;
    },
    onTextDelta: (delta) => {
      const last = messages.value[messages.value.length - 1];
      if (last && last.role === "assistant" && last.isStreaming) {
        last.text += delta;
      } else {
        messages.value.push({
          id: `stream_${Date.now()}`,
          role: "assistant",
          text: delta,
          thinking: "",
          toolCalls: [],
          isStreaming: true,
        });
      }
    },
    onThinkingDelta: (delta) => {
      const last = messages.value[messages.value.length - 1];
      if (last && last.role === "assistant" && last.isStreaming) {
        last.thinking += delta;
      }
    },
    onToolCall: (toolCall) => {
      const last = messages.value[messages.value.length - 1];
      if (last && last.role === "assistant") {
        last.toolCalls.push(toolCall);
      }
    },
    onStepEnd: () => {
      const last = messages.value[messages.value.length - 1];
      if (last && last.role === "assistant") {
        last.isStreaming = false;
      }
      isStreaming.value = false;
    },
    onError: (error) => {
      isStreaming.value = false;
      messages.value.push({
        id: `err_${Date.now()}`,
        role: "assistant",
        text: `Error: ${error}`,
        thinking: "",
        toolCalls: [],
        isStreaming: false,
      });
    },
    onClose: () => {
      isConnected.value = false;
      isStreaming.value = false;
    },
  });
}

function onSend(text: string) {
  if (!connection) return;
  messages.value.push({
    id: `u_${Date.now()}`,
    role: "user",
    text,
    thinking: "",
    toolCalls: [],
    isStreaming: false,
  });
  isStreaming.value = true;
  connection.send(text);
}

function recordsToDisplay(records: ChatMessageRecord[]): DisplayMessage[] {
  return records.map((r) => ({
    id: r.id,
    role: r.role,
    text: r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join(""),
    thinking: r.content.filter((c): c is { type: "think"; think: string } => c.type === "think").map((c) => c.think).join(""),
    toolCalls: r.toolCalls || [],
    isStreaming: false,
  }));
}
</script>

<style scoped>
.session-detail-page {
  position: absolute;
  top: 0;
  left: 0;
  right: 180px;
  bottom: 56px;
  display: flex;
  flex-direction: column;
  background: var(--mc-bg);
  color: var(--mc-text);
}
</style>

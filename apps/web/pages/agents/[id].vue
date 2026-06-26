<template>
  <div class="agent-edit-page">
    <header class="header">
      <BackButton />
      <h1>编辑 Agent</h1>
    </header>
    <main class="main">
      <AgentEditForm v-if="agent" :agent="agent" @save="onSave" @cancel="navigateTo('/hub')" />
      <div v-else class="empty">Agent 不存在</div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useAgentsStore } from "@/stores/agents";
import type { AgentConfig } from "@mindcloud/shared";

const route = useRoute();
const agents = useAgentsStore();

onMounted(() => {
  agents.load();
});

const agent = computed(() => agents.list.find((a) => a.id === route.params.id));

async function onSave(updated: AgentConfig) {
  await agents.update(updated.id, updated);
  navigateTo("/hub");
}
</script>

<style scoped>
.agent-edit-page {
  position: absolute;
  top: 0;
  left: 0;
  right: 180px;
  bottom: 56px;
  display: flex;
  flex-direction: column;
  background: var(--mc-bg);
  color: var(--mc-text);
  overflow: hidden;
}

.header {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.header h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 500;
}

.main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.empty {
  margin-top: 24px;
  color: var(--mc-text-secondary);
}
</style>

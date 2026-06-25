<template>
  <div class="agent-edit-page">
    <NuxtLink to="/hub">← 返回</NuxtLink>
    <h1>编辑 Agent</h1>
    <AgentEditForm v-if="agent" :agent="agent" @save="onSave" @cancel="navigateTo('/hub')" />
    <div v-else class="empty">Agent 不存在</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAgentsStore } from "@/stores/agents";
import type { AgentConfig } from "@mindcloud/shared";

const route = useRoute();
const agents = useAgentsStore();
const agent = computed(() => agents.list.find((a) => a.id === route.params.id));

async function onSave(updated: AgentConfig) {
  await agents.update(updated.id, updated);
  navigateTo("/hub");
}
</script>

<style scoped>
.agent-edit-page {
  padding: 24px;
  color: #d8e1ec;
  background: #0b0f17;
  min-height: 100vh;
}
.agent-edit-page a {
  color: #00e5c9;
}
.empty {
  margin-top: 24px;
  color: #8899aa;
}
</style>

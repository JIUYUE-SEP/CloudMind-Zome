<template>
  <div class="agent-new-page">
    <header class="header">
      <BackButton />
      <h1>新建 Agent</h1>
    </header>
    <main class="main">
      <AgentEditForm @save="onSave" @cancel="navigateTo('/hub')" />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useAgentsStore } from "@/stores/agents";
import type { AgentConfig } from "@mindcloud/shared";

const agents = useAgentsStore();

async function onSave(agent: AgentConfig) {
  await agents.create(agent);
  navigateTo("/hub");
}
</script>

<style scoped>
.agent-new-page {
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
</style>

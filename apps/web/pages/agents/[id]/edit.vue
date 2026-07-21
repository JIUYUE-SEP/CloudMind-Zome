<template>
  <AgentEditor :agent-id="agentId" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import AgentEditor from "@/components/agent-edit/AgentEditor.vue";

const route = useRoute();
const agentId = computed(() => route.params.id as string);
</script>

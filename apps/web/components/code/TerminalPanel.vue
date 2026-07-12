<template>
  <div class="terminal-panel">
    <div class="terminal-header">
      <span>Terminal</span>
      <button @click="$emit('clear')">Clear</button>
    </div>
    <pre class="terminal-content"><code>{{ output }}</code></pre>
  </div>
</template>

<script setup lang="ts">
defineProps<{ output: string }>();
defineEmits<{ (e: 'clear'): void }>();
</script>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0d1117;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #161b22;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
  color: #c9d1d9;
}
.terminal-header button {
  padding: 2px 8px;
  font-size: 11px;
  color: #c9d1d9;
  background: #21262d;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  cursor: pointer;
}
.terminal-header button:hover {
  background: #30363d;
}
.terminal-content {
  flex: 1;
  margin: 0;
  padding: 12px;
  overflow-y: auto;
  color: #e6edf3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

<template>
  <div class="file-tree">
    <div
      v-for="entry in entries"
      :key="entry.name"
      class="file-tree-entry"
      :class="`type-${entry.type}`"
      @click="onClick(entry)"
    >
      <span class="entry-icon">{{ entry.type === 'directory' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄' }}</span>
      <span class="entry-name">{{ entry.name }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
}

const props = defineProps<{ entries: FileEntry[] }>();
const emit = defineEmits<{ (e: 'open', entry: FileEntry): void }>();

function onClick(entry: FileEntry) {
  emit('open', entry);
}
</script>

<style scoped>
.file-tree {
  height: 100%;
  overflow-y: auto;
  padding: 8px 0;
  background: #1a1d21;
}
.file-tree-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: #c9d1d9;
  font-size: 13px;
  transition: background 0.15s ease;
}
.file-tree-entry:hover {
  background: rgba(255, 255, 255, 0.06);
}
.entry-icon {
  flex-shrink: 0;
  font-size: 14px;
}
.entry-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

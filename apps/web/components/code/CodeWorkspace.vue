<template>
  <div class="code-workspace">
    <div class="workspace-sidebar">
      <FileTree :entries="entries" @open="onFileOpen" />
    </div>
    <div class="workspace-main">
      <div class="editor-area">
        <CodeEditor v-model="currentFileContent" :language="currentLanguage" :path="currentFilePath" />
      </div>
      <div class="terminal-area">
        <TerminalPanel :output="terminalOutput" @clear="$emit('clearTerminal')" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import FileTree, { type FileEntry } from './FileTree.vue';
import CodeEditor from './CodeEditor.vue';
import TerminalPanel from './TerminalPanel.vue';

const props = defineProps<{
  entries: FileEntry[];
  terminalOutput: string;
  currentFileContent?: string;
  currentFilePath?: string;
}>();

const emit = defineEmits<{
  (e: 'openFile', path: string): void;
  (e: 'clearTerminal'): void;
}>();

const currentFileContent = ref(props.currentFileContent || '');
const currentFilePath = ref(props.currentFilePath || '');

watch(() => props.currentFileContent, (val) => {
  currentFileContent.value = val || '';
});

watch(() => props.currentFilePath, (val) => {
  currentFilePath.value = val || '';
});

const currentLanguage = computed(() => {
  const path = currentFilePath.value.toLowerCase();
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript';
  if (path.endsWith('.vue')) return 'html';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  return 'plaintext';
});

function onFileOpen(entry: FileEntry) {
  if (entry.type === 'directory') return;
  emit('openFile', entry.name);
}
</script>

<style scoped>
.code-workspace {
  display: flex;
  width: 100%;
  height: 100%;
  background: #0d1117;
  color: #e6edf3;
}
.workspace-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.workspace-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.editor-area {
  flex: 2;
  min-height: 0;
  overflow: hidden;
}
.terminal-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>

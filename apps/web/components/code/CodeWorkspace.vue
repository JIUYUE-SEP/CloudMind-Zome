<template>
  <div class="code-workspace">
    <div class="workspace-sidebar">
      <FileTree :entries="entries" @open="onFileOpen" />
    </div>
    <div class="workspace-main">
      <div class="editor-area">
        <CodeEditor
          :modelValue="currentFileContent"
          :path="currentFilePath"
          @update:modelValue="emit('update:currentFileContent', $event)"
        />
      </div>
      <div class="terminal-area">
        <TerminalPanel :output="terminalOutput" @clear="emit('clearTerminal')" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import FileTree, { type FileEntry } from './FileTree.vue';
import CodeEditor from './CodeEditor.vue';
import TerminalPanel from './TerminalPanel.vue';

withDefaults(defineProps<{
  entries: FileEntry[];
  terminalOutput: string;
  currentFileContent?: string;
  currentFilePath?: string;
}>(), {
  currentFileContent: '',
  currentFilePath: '',
});

const emit = defineEmits<{
  (e: 'openFile', path: string): void;
  (e: 'clearTerminal'): void;
  (e: 'update:currentFileContent', value: string): void;
  (e: 'update:currentFilePath', value: string): void;
}>();

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

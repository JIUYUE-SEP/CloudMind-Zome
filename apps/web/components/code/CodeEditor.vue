<template>
  <div ref="editorContainer" class="code-editor" />
</template>

<script setup lang="ts">
import { ref, onMounted, watch, onUnmounted, computed, shallowRef } from 'vue';
import loader from '@monaco-editor/loader';
import type * as monaco from 'monaco-editor';

const props = defineProps<{
  modelValue: string;
  language?: string;
  path?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const editorContainer = ref<HTMLElement | null>(null);
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
const monacoRef = shallowRef<typeof monaco | null>(null);
let model: monaco.editor.ITextModel | null = null;
let mounted = false;

const resolvedLanguage = computed(() => {
  if (props.language) return props.language;
  return inferLanguageFromPath(props.path || '');
});

function inferLanguageFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.vue')) return 'html';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.scss') || lower.endsWith('.sass')) return 'scss';
  if (lower.endsWith('.less')) return 'less';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return 'plaintext';
}

onMounted(async () => {
  mounted = true;
  if (!editorContainer.value) return;
  const m = await loader.init();
  if (!mounted) return;
  monacoRef.value = m;
  model = m.editor.createModel(props.modelValue, resolvedLanguage.value);
  const createdEditor = m.editor.create(editorContainer.value, {
    model,
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
  });
  editor.value = createdEditor;
  createdEditor.onDidChangeModelContent(() => {
    emit('update:modelValue', editor.value!.getValue());
  });
});

watch(
  () => props.modelValue,
  (val) => {
    if (editor.value && editor.value.getValue() !== val) {
      editor.value.setValue(val);
    }
  },
);

watch(
  () => resolvedLanguage.value,
  (lang) => {
    if (!editor.value || !model || !monacoRef.value) return;
    monacoRef.value.editor.setModelLanguage(model, lang);
  },
);

onUnmounted(() => {
  mounted = false;
  editor.value?.dispose();
  model?.dispose();
  editor.value = null;
  model = null;
});
</script>

<style scoped>
.code-editor {
  width: 100%;
  height: 100%;
  background: #1e1e1e;
}
</style>

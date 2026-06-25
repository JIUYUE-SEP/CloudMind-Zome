<template>
  <div class="model-selector">
    <select :value="modelId" @change="onChange">
      <option value="">请选择模型</option>
      <option v-for="m in models" :key="m.id" :value="m.id">{{ m.displayName || m.id }}</option>
    </select>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useComputeStore } from "@/stores/compute";

const props = defineProps<{
  providerId?: string | null;
  modelId?: string | null;
  modelType: "llm" | "embedding" | "image" | "stt";
}>();

const emit = defineEmits<{
  (e: "update:providerId", id: string): void;
  (e: "update:modelId", id: string): void;
}>();

const store = useComputeStore();

const models = computed(() => {
  if (props.providerId) {
    return store.getProvider(props.providerId)?.models.filter((m) => m.modelType === props.modelType) || [];
  }
  return store.providers.flatMap((p) =>
    p.models.filter((m) => m.modelType === props.modelType).map((m) => ({ ...m, providerId: p.id })),
  );
});

function onChange(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  const model = models.value.find((m) => m.id === id);
  if (model && "providerId" in model) {
    emit("update:providerId", model.providerId as string);
  }
  emit("update:modelId", id);
}
</script>

<style scoped>
.model-selector select {
  width: 100%;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #d8e1ec;
}
</style>

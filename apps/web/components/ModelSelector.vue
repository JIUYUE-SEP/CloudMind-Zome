<template>
  <div class="model-selector">
    <select :value="currentValue" @change="onChange">
      <option value="">请选择模型</option>
      <option v-for="m in models" :key="`${m.providerId}:${m.id}`" :value="`${m.providerId}:${m.id}`">
        {{ m.displayName || m.id }}<template v-if="!providerId">（{{ m.providerId }}）</template>
      </option>
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

// 统一带上 providerId：不同 provider 常有同名模型（如两家都有 gpt-4o），
// 只按 modelId 做 key/查找会撞键并选错 provider
const models = computed(() => {
  const all = store.providers.flatMap((p) =>
    p.models.filter((m) => m.modelType === props.modelType).map((m) => ({ ...m, providerId: p.id })),
  );
  const filtered = props.providerId ? all.filter((m) => m.providerId === props.providerId) : all;
  // 回显当前值：agent.json 已配置（providerId+modelId/model）但模型列表未收录时
  // （provider 列表尚未加载 / 模型已下架 / 列表与配置漂移），下拉不能显示空占位。
  // 补一个以当前配置为值的兜底项，保证打开编辑页能看见并保留既有选择。
  if (props.providerId && props.modelId && !filtered.some((m) => m.id === props.modelId)) {
    return [
      {
        id: props.modelId,
        displayName: props.modelId,
        modelType: props.modelType,
        providerId: props.providerId,
      },
      ...filtered,
    ];
  }
  return filtered;
});

const currentValue = computed(() =>
  props.providerId && props.modelId ? `${props.providerId}:${props.modelId}` : "",
);

function onChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) {
    // 清空时 providerId 也要一起清，否则会残留旧 provider 配空模型
    emit("update:providerId", "");
    emit("update:modelId", "");
    return;
  }
  // 按第一个冒号切分：前提是 providerId 不含冒号（engine 生成的 id 满足）；
  // modelId 含冒号（如 llama3.1:8b）会被完整保留
  const sep = value.indexOf(":");
  emit("update:providerId", value.slice(0, sep));
  emit("update:modelId", value.slice(sep + 1));
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

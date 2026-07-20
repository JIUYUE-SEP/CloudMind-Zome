<template>
  <div
    v-if="visible"
    ref="panelRef"
    class="wp-panel"
    :class="{ dragging }"
    :style="panelStyle"
    @click.stop
    @mousedown="onMouseDown"
  >
    <div class="wp-title">壁纸设置</div>

    <button class="wp-row-btn" @click="triggerUpload">上传新壁纸</button>
    <button v-if="wallpaperUrl" class="wp-row-btn danger" @click="clearWallpaper">恢复默认</button>

    <div class="wp-sep" />

    <div class="wp-label">显示模式</div>
    <div class="wp-mode-row">
      <button
        v-for="m in fitModes"
        :key="m.key"
        class="wp-mode-btn"
        :class="{ active: wallpaperFit === m.key }"
        @click="setFit(m.key)"
      >
        {{ m.label }}
      </button>
    </div>

    <div class="wp-sep" />

    <div class="wp-label">锚点位置</div>
    <div class="wp-anchor-grid">
      <button
        v-for="p in anchorList"
        :key="p"
        class="wp-anchor-btn"
        :class="{ active: wallpaperPos === p }"
        @click="setPos(p)"
      />
    </div>

    <input ref="fileInput" type="file" accept="image/*" style="display: none" @change="onFileChange" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "update", url: string, fit: string, pos: string): void;
}>();

const STORAGE_KEYS = {
  url: "mc-wallpaper-url",
  fit: "mc-wallpaper-fit",
  pos: "mc-wallpaper-position",
};

const panelRef = ref<HTMLElement>();
const fileInput = ref<HTMLInputElement>();
const dragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const dragPos = ref({ x: 0, y: 0 });
const panelStyle = computed(() => ({
  transform: `translate(${dragPos.value.x}px, ${dragPos.value.y}px)`,
}));

const wallpaperUrl = ref("");
const wallpaperFit = ref("cover");
const wallpaperPos = ref("center");

const fitModes = [
  { key: "cover", label: "填充" },
  { key: "contain", label: "适应" },
  { key: "stretch", label: "拉伸" },
  { key: "center", label: "平铺" },
];

const anchorList = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

onMounted(() => {
  loadFromStorage();
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      loadFromStorage();
    }
  },
);

function loadFromStorage() {
  if (typeof window === "undefined") return;
  wallpaperUrl.value = localStorage.getItem(STORAGE_KEYS.url) || "";
  wallpaperFit.value = localStorage.getItem(STORAGE_KEYS.fit) || "cover";
  wallpaperPos.value = localStorage.getItem(STORAGE_KEYS.pos) || "center";
}

function persist() {
  if (typeof window === "undefined") return;
  const previousUrl = localStorage.getItem(STORAGE_KEYS.url) || "";
  try {
    localStorage.setItem(STORAGE_KEYS.fit, wallpaperFit.value);
    localStorage.setItem(STORAGE_KEYS.pos, wallpaperPos.value);
    if (wallpaperUrl.value) {
      localStorage.setItem(STORAGE_KEYS.url, wallpaperUrl.value);
    } else {
      localStorage.removeItem(STORAGE_KEYS.url);
    }
  } catch {
    // base64 图片容易超 localStorage 配额（一般 5MB）；回滚到上一张已保存的壁纸而不是清空
    alert("壁纸保存失败：图片过大，浏览器存储空间不足，请换更小的图片");
    wallpaperUrl.value = previousUrl;
  }
  emit("update", wallpaperUrl.value, wallpaperFit.value, wallpaperPos.value);
}

function triggerUpload() {
  fileInput.value?.click();
}

const MAX_WALLPAPER_BYTES = 2 * 1024 * 1024;

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > MAX_WALLPAPER_BYTES) {
    alert("图片超过 2MB，无法用作壁纸（浏览器存储限制），请压缩后再试");
    (e.target as HTMLInputElement).value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    wallpaperUrl.value = reader.result as string;
    wallpaperFit.value = "cover";
    wallpaperPos.value = "center";
    persist();
  };
  reader.onerror = () => {
    alert("图片读取失败，请重试");
  };
  reader.readAsDataURL(file);
  (e.target as HTMLInputElement).value = "";
}

function clearWallpaper() {
  wallpaperUrl.value = "";
  wallpaperFit.value = "cover";
  wallpaperPos.value = "center";
  persist();
}

function setFit(key: string) {
  wallpaperFit.value = key;
  persist();
}

function setPos(pos: string) {
  wallpaperPos.value = pos;
  persist();
}

function onMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("wp-title")) return;
  dragging.value = true;
  dragOffset.value = {
    x: e.clientX - dragPos.value.x,
    y: e.clientY - dragPos.value.y,
  };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  dragPos.value = {
    x: e.clientX - dragOffset.value.x,
    y: e.clientY - dragOffset.value.y,
  };
}

function onMouseUp() {
  dragging.value = false;
  document.body.style.userSelect = "";
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}

// 拖拽中途组件被卸载时兜底清理 document 监听与 userSelect
onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
  document.body.style.userSelect = "";
});
</script>

<style scoped>
.wp-panel {
  position: absolute;
  bottom: 120px;
  /* 避开右侧导航条（.right-nav 宽 180px 在布局层 stacking context 中压在页面之上） */
  right: 200px;
  width: 220px;
  padding: 16px;
  background: rgba(11, 15, 23, 0.85);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  z-index: 120;
  color: var(--mc-text);
}

.wp-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  cursor: grab;
  user-select: none;
}

.wp-panel.dragging .wp-title {
  cursor: grabbing;
}

.wp-row-btn {
  width: 100%;
  padding: 8px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--mc-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.wp-row-btn:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.25);
}

.wp-row-btn.danger:hover {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.25);
  color: var(--mc-danger);
}

.wp-sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 12px 0;
}

.wp-label {
  font-size: 11px;
  color: var(--mc-text-secondary);
  margin-bottom: 8px;
}

.wp-mode-row {
  display: flex;
  gap: 6px;
}

.wp-mode-btn {
  flex: 1;
  padding: 6px 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  color: var(--mc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.wp-mode-btn.active,
.wp-mode-btn:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: var(--mc-accent);
}

.wp-anchor-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  width: 120px;
  margin: 0 auto;
}

.wp-anchor-btn {
  width: 100%;
  aspect-ratio: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.wp-anchor-btn:hover {
  background: rgba(0, 229, 201, 0.15);
}

.wp-anchor-btn.active {
  background: rgba(0, 229, 201, 0.3);
  border-color: rgba(0, 229, 201, 0.5);
}
</style>

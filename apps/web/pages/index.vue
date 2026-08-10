<template>
  <div class="home-view" :style="bgStyle">
    <div class="home-overlay">
      <div class="home-content">
        <h1 class="greeting">{{ greeting }}</h1>
        <p class="subtitle">{{ currentTime }}</p>
      </div>

      <button class="settings-btn" title="系统设置" @click="showSettings = !showSettings">设置</button>
      <button class="log-btn" title="系统日志" @click="showLog = !showLog">日志</button>
      <button class="wallpaper-btn" title="设置壁纸" @click="showPanel = !showPanel">壁纸</button>

      <SystemSettingsPanel :visible="showSettings" @close="showSettings = false" />
      <LogPanel ref="logPanelRef" :visible="showLog" @close="showLog = false" />
      <WallpaperPanel :visible="showPanel" @close="showPanel = false" @update="onWallpaperUpdate" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import SystemSettingsPanel from "@/components/SystemSettingsPanel.vue";
import LogPanel from "@/components/LogPanel.vue";
import WallpaperPanel from "@/components/WallpaperPanel.vue";

const STORAGE_KEYS = {
  url: "mc-wallpaper-url",
  fit: "mc-wallpaper-fit",
  pos: "mc-wallpaper-position",
};

const wallpaperUrl = ref("");
const wallpaperFit = ref("cover");
const wallpaperPos = ref("center");
const showPanel = ref(false);
const showLog = ref(false);
const showSettings = ref(false);
const currentTime = ref("");
const greeting = ref("");
const logPanelRef = ref<InstanceType<typeof LogPanel>>();

let timeTimer: ReturnType<typeof setInterval>;

function posToCss(p: string): string {
  const map: Record<string, string> = {
    "top-left": "0% 0%",
    "top-center": "50% 0%",
    "top-right": "100% 0%",
    "center-left": "0% 50%",
    center: "50% 50%",
    "center-right": "100% 50%",
    "bottom-left": "0% 100%",
    "bottom-center": "50% 100%",
    "bottom-right": "100% 100%",
  };
  return map[p] || "50% 50%";
}

function fitToCss(f: string): string {
  if (f === "stretch") return "100% 100%";
  if (f === "center") return "auto";
  return f;
}

const bgStyle = computed(() => {
  if (wallpaperUrl.value) {
    return {
      backgroundImage: `url(${wallpaperUrl.value})`,
      backgroundSize: fitToCss(wallpaperFit.value),
      backgroundPosition: posToCss(wallpaperPos.value),
      backgroundRepeat: wallpaperFit.value === "center" ? "repeat" : "no-repeat",
    };
  }
  return { background: "radial-gradient(ellipse at 50% 100%, rgba(0,229,201,0.04) 0%, #0B0F17 60%)" };
});

function updateGreeting() {
  const h = new Date().getHours();
  if (h < 6) greeting.value = "夜深了，Zome 与你同在";
  else if (h < 12) greeting.value = "早安，开始今天的调度吧";
  else if (h < 18) greeting.value = "下午好，心智阵列待命";
  else greeting.value = "晚上好，复盘今日行动";
}

function updateTime() {
  currentTime.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (showPanel.value && !target.closest(".wp-panel") && !target.closest(".wallpaper-btn")) {
    showPanel.value = false;
  }
  if (showLog.value && !target.closest(".log-panel") && !target.closest(".log-btn")) {
    showLog.value = false;
  }
  if (showSettings.value && !target.closest(".sys-settings-panel") && !target.closest(".settings-btn")) {
    showSettings.value = false;
  }
}

function onWallpaperUpdate(url: string, fit: string, pos: string) {
  wallpaperUrl.value = url;
  wallpaperFit.value = fit;
  wallpaperPos.value = pos;
}

onMounted(() => {
  if (typeof window !== "undefined") {
    wallpaperUrl.value = localStorage.getItem(STORAGE_KEYS.url) || "";
    wallpaperFit.value = localStorage.getItem(STORAGE_KEYS.fit) || "cover";
    wallpaperPos.value = localStorage.getItem(STORAGE_KEYS.pos) || "center";
  }
  updateTime();
  updateGreeting();
  timeTimer = setInterval(() => {
    updateTime();
    updateGreeting();
  }, 1000);
  document.addEventListener("click", onDocClick);
});

onBeforeUnmount(() => {
  clearInterval(timeTimer);
  document.removeEventListener("click", onDocClick);
});

</script>

<style scoped>
.home-view {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.home-overlay {
  position: absolute;
  inset: 0;
  background: rgba(11, 15, 23, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}

.home-content {
  text-align: center;
  color: var(--mc-text);
}

.greeting {
  font-size: 32px;
  font-weight: 500;
  margin: 0 0 12px;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}

.subtitle {
  font-size: 16px;
  color: var(--mc-text-secondary);
  margin: 0;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
}

.settings-btn,
.log-btn,
.wallpaper-btn {
  position: absolute;
  bottom: 72px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(20, 27, 36, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--mc-text);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  transition: all 0.2s;
  z-index: 110;
}

.settings-btn:hover,
.log-btn:hover,
.wallpaper-btn:hover {
  background: rgba(0, 229, 201, 0.15);
  border-color: rgba(0, 229, 201, 0.3);
}

.settings-btn {
  right: 116px;
}

.log-btn {
  right: 68px;
}

.wallpaper-btn {
  right: 20px;
}

</style>

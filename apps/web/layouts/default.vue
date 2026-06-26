<template>
  <div class="app-shell">
    <div class="main-visual">
      <slot />
    </div>

    <nav class="right-nav">
      <NuxtLink
        v-for="item in navItems"
        :key="item.label"
        :to="item.to"
        class="nav-item"
        :class="{ placeholder: item.placeholder }"
        @click="handleNav($event, item)"
      >
        <span class="nav-label">{{ item.label }}</span>
      </NuxtLink>
    </nav>

    <footer class="bottom-bar">
      <div class="bar-left">
        <button class="bar-avatar" title="个人信息" @click="showProfileModal = true">
          <span>我</span>
        </button>
        <button class="bar-btn" @click="navigateTo('/self-image')">心智侧写</button>
        <button class="bar-btn" @click="navigateTo('/user-profile')">用户档案</button>
        <button class="bar-btn" @click="navigateTo('/compute')">算力余量</button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
interface NavItem {
  label: string;
  to: string;
  placeholder?: boolean;
}

const navItems: NavItem[] = [
  { label: "行动中心", to: "/actions" },
  { label: "心智整备", to: "/agents/new" },
  { label: "自动委托", to: "/commissions" },
  { label: "心智招募", to: "/agents/new" },
  { label: "通讯中枢", to: "/hub" },
  { label: "广播站", to: "", placeholder: true },
];

const showProfileModal = ref(false);

function handleNav(e: Event, item: NavItem) {
  if (item.placeholder) {
    e.preventDefault();
  }
}
</script>

<style scoped>
.app-shell {
  position: fixed;
  inset: 0;
  background: var(--mc-bg);
  color: var(--mc-text);
  font-family: system-ui, -apple-system, sans-serif;
  overflow: hidden;
}

.main-visual {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.right-nav {
  position: absolute;
  right: 0;
  top: 120px;
  bottom: 120px;
  width: 180px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  z-index: 100;
  background: linear-gradient(to left, rgba(11, 15, 23, 0.9), transparent);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--mc-text);
  text-decoration: none;
  transition: background 0.2s;
}

.nav-item:hover:not(.placeholder) {
  background: rgba(0, 229, 201, 0.08);
}

.nav-item.placeholder {
  opacity: 0.4;
  cursor: default;
}

.nav-label {
  font-size: 13px;
}

.bottom-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  z-index: 100;
  background: rgba(11, 15, 23, 0.25);
  backdrop-filter: blur(12px);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.bar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bar-btn {
  background: transparent;
  border: none;
  color: var(--mc-text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 6px 12px;
  transition: color 0.15s;
}

.bar-btn:hover {
  color: var(--mc-accent);
}

.bar-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(20, 27, 36, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--mc-text-secondary);
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0;
  flex-shrink: 0;
  transition: border-color 0.15s;
}

.bar-avatar:hover {
  border-color: rgba(0, 229, 201, 0.3);
}
</style>

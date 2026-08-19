<template>
  <div class="changelog-page">
    <header class="header">
      <BackButton to="/" />
      <h1>广播站</h1>
    </header>

    <p class="page-subtitle">更新日志</p>

    <!-- 数据源为 content/changelog.ts 静态条目（最新在前），空数组时给空态 -->
    <div v-if="!entries.length" class="empty">暂无更新日志</div>
    <ul v-else class="entry-list">
      <li v-for="entry in entries" :key="entry.version + entry.date" class="entry-card">
        <div class="entry-head">
          <span class="entry-version">{{ entry.version }}</span>
          <span class="entry-date">{{ entry.date }}</span>
        </div>
        <h2 class="entry-title">{{ entry.title }}</h2>
        <ul class="entry-items">
          <li v-for="(item, i) in entry.items" :key="i">{{ item }}</li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { changelogEntries } from "@/content/changelog";

// 静态数据源，直接引用（最新在前，页面按数组序渲染）
const entries = changelogEntries;
</script>

<style scoped>
.changelog-page {
  position: absolute;
  inset: 0;
  padding: 24px 24px 80px;
  color: var(--mc-text);
  background: var(--mc-bg);
  overflow-y: auto;
}

.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 8px;
}

.header h1 {
  margin: 0;
  font-size: 24px;
}

.page-subtitle {
  margin: 0 0 24px;
  font-size: 13px;
  color: var(--mc-text-tertiary);
}

.empty {
  color: var(--mc-text-tertiary);
  font-size: 13px;
  padding: 24px 0;
}

.entry-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.entry-card {
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}

.entry-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.entry-version {
  font-size: 14px;
  font-weight: 600;
  color: var(--mc-accent);
}

.entry-date {
  font-size: 12px;
  color: var(--mc-text-tertiary);
}

.entry-title {
  margin: 8px 0;
  font-size: 16px;
}

.entry-items {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--mc-text-secondary);
}
</style>

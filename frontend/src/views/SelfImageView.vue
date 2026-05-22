<template>
  <div class="self-image-view">
    <!-- 左侧：心智列表 -->
    <aside class="si-sidebar">
      <div class="sidebar-header">
        <BackButton />
        <h3>心智侧写</h3>
      </div>
      <div class="sidebar-list">
        <div
          v-for="a in agentsStore.list"
          :key="a.id"
          class="agent-row"
          :class="{ active: selectedId === a.id }"
          @click="selectAgent(a.id)"
        >
          <img v-if="a.portrait_url" :src="a.portrait_url" class="agent-avatar" />
          <div
            v-else
            class="agent-avatar fallback"
            :style="{ backgroundColor: a.represent_color }"
          >
            {{ a.name.charAt(0) }}
          </div>
          <div class="agent-meta">
            <div class="agent-name">{{ a.name }}</div>
            <div class="agent-code">{{ a.codename }}</div>
          </div>
        </div>
        <div v-if="!agentsStore.list.length" class="sidebar-empty">暂无心智</div>
      </div>
    </aside>

    <!-- 中间：展示该心智眼中的你 -->
    <main v-if="selectedAgent" class="si-main">
      <div class="perception-card">
        <div class="card-header">
          <img
            v-if="selectedAgent.portrait_url"
            :src="selectedAgent.portrait_url"
            class="card-avatar"
          />
          <div
            v-else
            class="card-avatar fallback"
            :style="{ backgroundColor: selectedAgent.represent_color }"
          >
            {{ selectedAgent.name.charAt(0) }}
          </div>
          <div class="card-title">
            <div class="card-name">{{ selectedAgent.name }}</div>
            <div class="card-sub">{{ selectedAgent.codename }} 眼中的你</div>
          </div>
        </div>

        <div class="card-body">
          <div class="perception-text">{{ perceptionText }}</div>

          <div class="trait-row">
            <span class="trait-label">关系阶段</span>
            <div class="trait-bar">
              <div class="trait-fill" :style="{ width: familiarity + '%' }" />
            </div>
            <span class="trait-value">{{ familiarity }}%</span>
          </div>

          <div class="keywords">
            <span
              v-for="k in keywords"
              :key="k"
              class="keyword"
              :style="{ borderColor: selectedAgent.represent_color, color: selectedAgent.represent_color }"
            >
              {{ k }}
            </span>
          </div>
        </div>
      </div>
    </main>

    <!-- 空状态 -->
    <main v-else class="si-main empty">
      <div class="empty-hint">选择一个心智，了解它如何看待你</div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import BackButton from '@/components/BackButton.vue'

const agentsStore = useAgentsStore()
const auth = useAuthStore()
const selectedId = ref<string | null>(null)

const selectedAgent = computed(() =>
  agentsStore.list.find((a) => a.id === selectedId.value)
)

const familiarity = computed(() => {
  // 基于创建时间模拟熟悉度（实际应从交互数据计算）
  if (!selectedAgent.value) return 0
  const created = selectedAgent.value.created_at
    ? new Date(selectedAgent.value.created_at).getTime()
    : Date.now()
  const days = Math.floor((Date.now() - created) / 86400000)
  return Math.min(30 + days * 5, 100)
})

const perceptionText = computed(() => {
  const a = selectedAgent.value
  const u = auth.user
  if (!a || !u) return ''
  const name = u.nickname || u.codename || '你'
  return `${a.name}（${a.codename}）对${name}的印象：\n\n"${name}是一个值得关注的对象。${a.personality_summary || ''}"`
})

const keywords = computed(() => {
  const a = selectedAgent.value
  if (!a) return []
  const base = ['观察者', '协作者']
  const summary = (a.personality_summary || '').toLowerCase()
  if (summary.includes('代码') || summary.includes('程序')) base.push('技术伙伴')
  if (summary.includes('文') || summary.includes('写')) base.push('创作伙伴')
  return base
})

onMounted(() => {
  agentsStore.fetchList().then(() => {
    if (agentsStore.list.length && !selectedId.value) {
      selectedId.value = agentsStore.list[0].id
    }
  })
})

function selectAgent(id: string) {
  selectedId.value = id
}
</script>

<style scoped>
.self-image-view {
  position: fixed;
  inset: 0;
  background: #0b0f17;
  z-index: 900;
  display: flex;
  color: #d8e1ec;
  font-family: system-ui, -apple-system, sans-serif;
}

/* Sidebar */
.si-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  background: rgba(11, 15, 23, 0.8);
}
.sidebar-header {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.sidebar-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.agent-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.agent-row.active {
  background: rgba(0, 229, 201, 0.08);
}
.agent-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.agent-avatar.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #0b0f17;
}
.agent-meta {
  min-width: 0;
}
.agent-name {
  font-size: 13px;
  color: #d8e1ec;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-code {
  font-size: 11px;
  color: #5a6a7a;
}
.sidebar-empty {
  padding: 20px;
  text-align: center;
  color: #5a6a7a;
  font-size: 13px;
}

/* Main */
.si-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}
.si-main.empty {
  color: #5a6a7a;
  font-size: 14px;
}
.perception-card {
  width: 100%;
  max-width: 560px;
  background: rgba(20, 27, 36, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 16px;
  padding: 32px;
}
.card-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}
.card-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
}
.card-avatar.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 600;
  color: #0b0f17;
}
.card-name {
  font-size: 18px;
  font-weight: 500;
  color: #d8e1ec;
}
.card-sub {
  font-size: 13px;
  color: #5a6a7a;
  margin-top: 4px;
}
.perception-text {
  font-size: 15px;
  line-height: 1.8;
  color: #b0c0d0;
  white-space: pre-wrap;
  margin-bottom: 24px;
}
.trait-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}
.trait-label {
  font-size: 12px;
  color: #8899aa;
  width: 60px;
  flex-shrink: 0;
}
.trait-bar {
  flex: 1;
  height: 6px;
  background: #1e2731;
  border-radius: 3px;
  overflow: hidden;
}
.trait-fill {
  height: 100%;
  background: #00e5c9;
  border-radius: 3px;
  transition: width 0.6s ease;
}
.trait-value {
  font-size: 12px;
  color: #00e5c9;
  width: 36px;
  text-align: right;
}
.keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.keyword {
  padding: 5px 12px;
  border: 1px solid;
  border-radius: 12px;
  font-size: 12px;
  background: rgba(0, 229, 201, 0.05);
}
</style>

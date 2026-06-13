<template>
  <div class="ae-panel-section">
    <div class="skills-layout">
      <div class="skills-left">
        <label class="ae-label">能力标签</label>
        <TagInput v-model="capabilities" placeholder="+ 添加能力" />

        <label class="ae-label" style="margin-top: 16px">代称 / 昵称</label>
        <TagInput v-model="aliases" placeholder="+ 添加代称（如 vivi）" />

        <label class="ae-label" style="margin-top: 16px">分组标签</label>
        <TagInput v-model="tags" warning placeholder="+ 添加分组标签" />
      </div>

      <div class="skills-right">
        <div class="skills-header">
          <label class="ae-label">技能指令</label>
          <button class="ae-mini-btn" :disabled="!agent.id || loading" @click="triggerUpload">
            上传 Skill
          </button>
        </div>
        <div class="ae-hint" style="margin-bottom: 8px">
          勾选后会在每次对话时注入该技能指引到 system prompt。
        </div>
        <div v-if="skillsLoading" class="ae-hint">加载中...</div>
        <div v-else-if="!discoveredSkills.length" class="ae-hint">
          暂无技能。点击“上传 Skill”添加 SKILL.md 文件。
        </div>
        <div v-for="sk in discoveredSkills" :key="sk.name" class="skill-row">
          <input
            type="checkbox"
            :checked="enabledSkills.includes(sk.name)"
            @change="toggleSkill(sk.name)"
          />
          <div class="skill-info">
            <div class="skill-name">{{ sk.name }}</div>
            <div class="skill-desc">{{ sk.description }}</div>
          </div>
          <button class="skill-delete" @click="deleteSkill(sk.name)">×</button>
        </div>
      </div>
    </div>

    <input ref="skillInput" type="file" accept=".md" style="display: none" @change="onSkillFileSelected" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { api } from '@/api/client'
import { pushLog } from '@/composables/useWebSocket'
import TagInput from '@/components/ui/TagInput.vue'

interface AgentSkillsData {
  id?: string | null
  capabilities?: string[]
  aliases?: string[]
  tags?: string[]
  enabled_skills?: string[]
}

const props = defineProps<{
  agent: AgentSkillsData
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentSkillsData>]
  save: [field: string]
  reset: [field: string]
}>()

const capabilities = ref<string[]>([...(props.agent.capabilities || [])])
const aliases = ref<string[]>([...(props.agent.aliases || [])])
const tags = ref<string[]>([...(props.agent.tags || [])])
const enabledSkills = ref<string[]>([...(props.agent.enabled_skills || [])])
const discoveredSkills = ref<any[]>([])
const skillsLoading = ref(false)
const skillInput = ref<HTMLInputElement>()

watch(() => props.agent.capabilities, (v) => { capabilities.value = [...(v || [])] }, { deep: true })
watch(() => props.agent.aliases, (v) => { aliases.value = [...(v || [])] }, { deep: true })
watch(() => props.agent.tags, (v) => { tags.value = [...(v || [])] }, { deep: true })
watch(() => props.agent.enabled_skills, (v) => { enabledSkills.value = [...(v || [])] }, { deep: true })

watch(capabilities, (v) => emit('update:agent', { capabilities: v }), { deep: true })
watch(aliases, (v) => emit('update:agent', { aliases: v }), { deep: true })
watch(tags, (v) => emit('update:agent', { tags: v }), { deep: true })

onMounted(() => {
  if (props.agent.id) loadDiscoveredSkills()
})

watch(() => props.agent.id, (id) => {
  if (id) loadDiscoveredSkills()
})

async function loadDiscoveredSkills() {
  if (!props.agent.id) return
  skillsLoading.value = true
  try {
    const json = await api.get(`/agents/${props.agent.id}/skills/discovered`)
    discoveredSkills.value = json.code === 0 ? json.data || [] : []
  } catch (e: any) {
    discoveredSkills.value = []
    pushLog({ type: 'error', source: 'AgentEditSkills', message: `加载技能失败: ${e}` })
  } finally {
    skillsLoading.value = false
  }
}

function toggleSkill(name: string) {
  const has = enabledSkills.value.includes(name)
  enabledSkills.value = has
    ? enabledSkills.value.filter((n) => n !== name)
    : [...enabledSkills.value, name]
  emit('update:agent', { enabled_skills: [...enabledSkills.value] })
}

function triggerUpload() {
  skillInput.value?.click()
}

async function onSkillFileSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file || !props.agent.id) return
  const fd = new FormData()
  fd.append('file', file)
  try {
    const json = await api.upload(`/agents/${props.agent.id}/skills/upload`, fd)
    if (json.code === 0) {
      pushLog({ type: 'success', source: 'AgentEditSkills', message: `技能 ${json.data?.name} 已上传` })
      await loadDiscoveredSkills()
    } else {
      pushLog({ type: 'error', source: 'AgentEditSkills', message: `上传技能失败: ${json.message}` })
    }
  } catch (e: any) {
    pushLog({ type: 'error', source: 'AgentEditSkills', message: `上传技能失败: ${e}` })
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function deleteSkill(name: string) {
  if (!props.agent.id) return
  if (!confirm(`确定要删除技能 "${name}" 吗？`)) return
  try {
    const json = await api.delete(`/agents/${props.agent.id}/skills/${encodeURIComponent(name)}`)
    if (json.code === 0) {
      enabledSkills.value = enabledSkills.value.filter((n) => n !== name)
      emit('update:agent', { enabled_skills: [...enabledSkills.value] })
      await loadDiscoveredSkills()
      pushLog({ type: 'success', source: 'AgentEditSkills', message: `技能 ${name} 已删除` })
    } else {
      pushLog({ type: 'error', source: 'AgentEditSkills', message: `删除技能失败: ${json.message}` })
    }
  } catch (e: any) {
    pushLog({ type: 'error', source: 'AgentEditSkills', message: `删除技能失败: ${e}` })
  }
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.skills-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.skills-right {
  border-top: 1px solid var(--ae-border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skills-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.skill-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  background: var(--ae-input-bg);
  border: 1px solid var(--ae-input-border);
  border-radius: 8px;
}

.skill-row input[type='checkbox'] {
  width: auto;
  margin-top: 2px;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--ae-text);
}

.skill-desc {
  font-size: 11px;
  color: var(--ae-text-dim);
  margin-top: 2px;
  line-height: 1.4;
}

.skill-delete {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--ae-text-dim);
  font-size: 14px;
  cursor: pointer;
}

.skill-delete:hover {
  color: var(--ae-danger);
}
</style>

<template>
  <div class="modal-overlay" @click="$emit('close')">
    <div class="modal-card" @click.stop>
      <div class="modal-header">
        <h3>个人信息</h3>
        <button class="close-btn" @click="$emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="avatar-row">
          <img v-if="form.avatar_url" :src="$uploadUrl(form.avatar_url)" class="avatar" />
          <div v-else class="avatar fallback">?</div>
          <button class="upload-avatar" @click="triggerAvatar">更换头像</button>
        </div>

        <label class="field-label">代号</label>
        <input v-model="form.codename" disabled />

        <label class="field-label">昵称</label>
        <input v-model="form.nickname" placeholder="你的心智如何称呼你" />

        <label class="field-label">用户档案 (profile.md)</label>
        <div class="profile-md-hint" style="font-size: 11px; color: #5A6A7A; margin-bottom: 4px;">
          所有 Agent 共享这份档案，内容会在每次对话时注入 system prompt
        </div>
        <textarea
          v-model="profileMd.content"
          :disabled="profileMd.loading"
          rows="10"
          placeholder="编辑你的 profile.md..."
          style="width: 100%; padding: 10px; background: #141b24; border: 1px solid #1e2731; border-radius: 8px; color: #d8e1ec; font-size: 13px; font-family: monospace; box-sizing: border-box; resize: vertical;"
        />
        <div v-if="profileMd.loading" style="font-size: 11px; color: #5A6A7A;">加载中...</div>

        <div v-if="saveError" class="save-error">{{ saveError }}</div>
      </div>

      <div class="modal-actions">
        <button class="save-btn" @click="save">保存</button>
        <button class="cancel-btn" @click="$emit('close')">取消</button>
      </div>
    </div>
  </div>

  <input ref="avatarInput" type="file" accept="image/*" style="display: none" @change="uploadAvatar" />
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/api/client'

const emit = defineEmits(['close'])
const auth = useAuthStore()

const form = ref({
  codename: '',
  nickname: '',
  avatar_url: '',
})
const saveError = ref('')
const avatarInput = ref<HTMLInputElement>()

const profileMd = ref({ content: '', loading: false, saving: false })

onMounted(() => {
  const u = auth.user
  if (u) {
    form.value = {
      codename: u.codename || '',
      nickname: u.nickname || '',
      avatar_url: u.avatar_url || '',
    }
  }
  loadProfileMd()
})

async function loadProfileMd() {
  profileMd.value.loading = true
  try {
    const json = await api.get('/auth/me/profile-md')
    if (json.code === 0) {
      profileMd.value.content = json.data?.content || ''
    }
  } catch (e: any) {
    console.error('加载 profile.md 失败:', e)
  } finally {
    profileMd.value.loading = false
  }
}

async function save() {
  saveError.value = ''
  try {
    const [profileJson, authJson] = await Promise.all([
      api.put('/auth/me/profile-md', { content: profileMd.value.content }),
      auth.updateProfile({
        nickname: form.value.nickname,
      }),
    ])
    const errors: string[] = []
    if (profileJson.code !== 0) {
      errors.push(profileJson.message || '保存 profile.md 失败')
    }
    if (authJson.code !== 0) {
      errors.push(authJson.message || '保存个人信息失败')
    }
    if (errors.length) {
      saveError.value = errors.join('；')
      return
    }
    emit('close')
  } catch (e: any) {
    saveError.value = e?.message || '保存失败'
  }
}

function triggerAvatar() {
  avatarInput.value?.click()
}

async function uploadAvatar(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  const json = await api.upload('/upload?folder=avatars', fd)
  if (json.code === 0) {
    const apiRes = await auth.updateProfile({ avatar_url: json.data.url })
    if (apiRes.code === 0) {
      form.value.avatar_url = json.data.url
    }
  }
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-card {
  width: 360px;
  background: rgba(11, 15, 23, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.modal-header h3 {
  margin: 0;
  font-size: 16px;
  color: #d8e1ec;
  font-weight: 500;
}
.close-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: transparent;
  border: none;
  color: #5a6a7a;
  font-size: 20px;
  cursor: pointer;
}
.close-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #d8e1ec;
}
.modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.avatar-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  background: #141b24;
}
.avatar.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  color: #5a6a7a;
}
.upload-avatar {
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #8899aa;
  font-size: 12px;
  cursor: pointer;
}
.upload-avatar:hover {
  border-color: rgba(0, 229, 201, 0.3);
  color: #00e5c9;
}
.field-label {
  font-size: 12px;
  color: #8899aa;
}
.modal-body input {
  width: 100%;
  padding: 10px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 8px;
  color: #d8e1ec;
  font-size: 13px;
  box-sizing: border-box;
}
.modal-body input:focus {
  outline: none;
  border-color: rgba(0, 229, 201, 0.4);
}
.modal-body input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.save-error {
  padding: 8px 10px;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border-radius: 6px;
  font-size: 13px;
}
.modal-actions {
  display: flex;
  gap: 10px;
  padding: 16px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.save-btn {
  flex: 1;
  padding: 10px;
  background: #00e5c9;
  color: #0b0f17;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.cancel-btn {
  flex: 1;
  padding: 10px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #8899aa;
  font-size: 13px;
  cursor: pointer;
}
.cancel-btn:hover {
  border-color: rgba(255, 255, 255, 0.2);
  color: #d8e1ec;
}
</style>

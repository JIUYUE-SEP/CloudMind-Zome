<template>
  <div class="modal-overlay" @click="$emit('close')">
    <div class="modal-card" @click.stop>
      <div class="modal-header">
        <h3>个人信息</h3>
        <button class="close-btn" @click="$emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="avatar-row">
          <img v-if="form.avatar_url" :src="form.avatar_url" class="avatar" />
          <div v-else class="avatar fallback">?</div>
          <button class="upload-avatar" @click="triggerAvatar">更换头像</button>
        </div>

        <label class="field-label">代号</label>
        <input v-model="form.codename" disabled />

        <label class="field-label">昵称</label>
        <input v-model="form.nickname" placeholder="你的心智如何称呼你" />

        <label class="field-label">个人简介</label>
        <textarea v-model="form.bio" rows="3" placeholder="描述你的身份、职业、兴趣...心智会根据这些了解你" />

        <label class="field-label">签名</label>
        <input v-model="form.quote" placeholder="一句代表你的话" />

        <label class="field-label">身份标签</label>
        <div class="tag-list">
          <span v-for="(t, i) in form.tags" :key="i" class="tag">
            {{ t }}
            <button @click="removeTag(i)">×</button>
          </span>
          <input v-model="tagInput" @keydown.enter.prevent="addTag" placeholder="+ 添加标签" />
        </div>

        <div v-if="saveError" class="save-error">{{ saveError }}</div>
      </div>

      <div class="modal-actions">
        <button class="save-btn" @click="save">保存</button>
        <button class="cancel-btn" @click="$emit('close')">取消</button>
      </div>
      <div class="modal-extra">
        <button class="link-btn" @click="goUserProfile">
          ✎ 编辑档案文件（profile.md）
        </button>
      </div>
    </div>
  </div>

  <input ref="avatarInput" type="file" accept="image/*" style="display: none" @change="uploadAvatar" />
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/api/client'

const emit = defineEmits(['close'])
const auth = useAuthStore()
const router = useRouter()

const form = ref({
  codename: '',
  nickname: '',
  avatar_url: '',
  bio: '',
  quote: '',
  tags: [] as string[],
})
const tagInput = ref('')
const saveError = ref('')
const avatarInput = ref<HTMLInputElement>()

onMounted(() => {
  const u = auth.user
  if (u) {
    form.value = {
      codename: u.codename || '',
      nickname: u.nickname || '',
      avatar_url: u.avatar_url || '',
      bio: u.profile?.bio || '',
      quote: u.profile?.quote || '',
      tags: Array.isArray(u.profile?.tags) ? [...u.profile.tags] : [],
    }
  }
})

function addTag() {
  const t = tagInput.value.trim()
  if (t && !form.value.tags.includes(t)) form.value.tags.push(t)
  tagInput.value = ''
}
function removeTag(i: number) {
  form.value.tags.splice(i, 1)
}

async function save() {
  saveError.value = ''
  const json = await auth.updateProfile({
    nickname: form.value.nickname,
    bio: form.value.bio,
    quote: form.value.quote,
    tags: form.value.tags,
  })
  if (json.code === 0) {
    emit('close')
  } else {
    saveError.value = json.message || '保存失败'
  }
}

function triggerAvatar() {
  avatarInput.value?.click()
}

function goUserProfile() {
  emit('close')
  router.push('/user-profile')
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
  width: 420px;
  max-height: 80vh;
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
  flex: 1;
  overflow-y: auto;
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
.modal-body input,
.modal-body textarea {
  width: 100%;
  padding: 10px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 8px;
  color: #d8e1ec;
  font-size: 13px;
  box-sizing: border-box;
}
.modal-body input:focus,
.modal-body textarea:focus {
  outline: none;
  border-color: rgba(0, 229, 201, 0.4);
}
.modal-body input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: rgba(0, 229, 201, 0.1);
  color: #00e5c9;
  border-radius: 12px;
  font-size: 12px;
}
.tag button {
  background: transparent;
  border: none;
  color: #00e5c9;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
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

.modal-extra {
  padding: 8px 20px 16px;
  text-align: center;
}
.link-btn {
  background: transparent;
  border: none;
  color: #00e5c9;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
  opacity: 0.8;
}
.link-btn:hover {
  opacity: 1;
}
</style>

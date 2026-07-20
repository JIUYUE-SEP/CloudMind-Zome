<template>
  <div class="user-profile-page">
    <header class="up-header">
      <div class="up-header-left">
        <BackButton />
        <h1>用户档案</h1>
      </div>
      <div class="up-actions">
        <span v-if="saveMsg" class="save-msg" :class="{ error: saveFailed }">{{ saveMsg }}</span>
        <button class="save-btn" @click="save">保存</button>
      </div>
    </header>

    <main class="up-body">
      <div class="up-preview">
        <div
          class="up-avatar"
          :style="{ backgroundColor: store.profile.representColor || '#00e5c9' }"
        >
          {{ nicknameInitial }}
        </div>
        <p class="up-preview-hint">头像将使用昵称首字母与代表色</p>
      </div>

      <div class="up-form">
        <label>
          昵称
          <input v-model="store.profile.nickname" type="text" placeholder="怎么称呼你" />
        </label>

        <label>
          简介
          <textarea
            v-model="store.profile.bio"
            rows="5"
            placeholder="写一段关于你的简介……"
          />
        </label>

        <label class="color-field">
          代表色
          <input v-model="store.profile.representColor" type="color" />
          <span class="color-value">{{ store.profile.representColor }}</span>
        </label>
      </div>

      <p class="up-hint">
        这些信息仅保存在当前浏览器的 localStorage 中，不会上传到服务器。
      </p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useUserProfileStore } from "@/stores/user-profile";
import BackButton from "@/components/BackButton.vue";

const store = useUserProfileStore();
const saveMsg = ref("");
const saveFailed = ref(false);
let msgTimer: ReturnType<typeof setTimeout> | null = null;

const nicknameInitial = computed(() => {
  const name = store.profile.nickname || "我";
  return name.trim().charAt(0) || "我";
});

function save() {
  try {
    store.save();
    saveFailed.value = false;
    saveMsg.value = "已保存";
  } catch {
    // localStorage 不可用（隐私模式/超限）
    saveFailed.value = true;
    saveMsg.value = "保存失败：浏览器存储不可用";
  }
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (saveMsg.value = ""), 1500);
}

onMounted(() => {
  store.load();
});

onBeforeUnmount(() => {
  if (msgTimer) clearTimeout(msgTimer);
});
</script>

<style scoped>
.user-profile-page {
  position: absolute;
  inset: 0;
  background: var(--mc-bg);
  color: var(--mc-text);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.up-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid var(--mc-border);
  flex-shrink: 0;
}

.up-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.up-header h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.save-btn {
  padding: 6px 16px;
  background: var(--mc-accent);
  color: #0b0f17;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.up-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.save-msg {
  font-size: 12px;
  color: var(--mc-success);
}

.save-msg.error {
  color: var(--mc-danger);
}

.up-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px;
  max-width: 560px;
  margin: 0 auto;
  width: 100%;
}

.up-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
}

.up-avatar {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36px;
  font-weight: 600;
  color: #0b0f17;
}

.up-preview-hint {
  margin: 0;
  font-size: 12px;
  color: var(--mc-text-secondary);
}

.up-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.up-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--mc-text-secondary);
}

.up-form input,
.up-form textarea {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--mc-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 14px;
  outline: none;
}

.up-form input::placeholder,
.up-form textarea::placeholder {
  color: var(--mc-text-tertiary);
}

.up-form input:focus,
.up-form textarea:focus {
  border-color: rgba(0, 229, 201, 0.3);
}

.up-form textarea {
  resize: vertical;
  line-height: 1.6;
}

.color-field {
  flex-direction: row !important;
  align-items: center;
  gap: 12px !important;
}

.color-field input[type="color"] {
  width: 40px;
  height: 40px;
  padding: 2px;
  border-radius: 6px;
  cursor: pointer;
}

.color-value {
  font-family: monospace;
  color: var(--mc-text);
}

.up-hint {
  margin-top: 16px;
  font-size: 12px;
  color: var(--mc-text-tertiary);
  line-height: 1.5;
}
</style>

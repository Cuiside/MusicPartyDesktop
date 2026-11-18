<script setup>
import { ref, watch } from 'vue'
import { UserRound } from 'lucide-vue-next'

const props = defineProps({
  open: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
  initial: { type: String, default: '' }
})
const emit = defineEmits(['submit', 'close'])

const value = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    value.value = props.initial || ''
    setTimeout(() => document.getElementById('nickname-input')?.focus(), 60)
  }
)

const submit = () => {
  const name = value.value.trim()
  if (!name || props.busy) return
  emit('submit', name)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="dialog-backdrop" @mousedown.self="emit('close')">
        <div class="dialog join-dialog" role="dialog" aria-label="设置昵称">
          <div class="join-head">
            <span class="label">设置昵称 · NICKNAME</span>
            <span class="join-title">先设置一个昵称</span>
          </div>

          <div class="join-form">
            <p class="join-hint">
              当前是游客身份，只能浏览和点歌；设置昵称后会加入成员列表，才能暂停、切歌等控制播放。
            </p>
            <label class="join-field">
              <span class="join-label"><UserRound :size="12" /> 昵称</span>
              <input
                id="nickname-input"
                v-model="value"
                class="text-field"
                maxlength="32"
                placeholder="例如：小云（不能使用「游客」）"
                spellcheck="false"
                @keydown.enter.prevent="submit"
              />
            </label>
            <p v-if="error" class="join-error">{{ error }}</p>
          </div>

          <div class="join-actions">
            <button class="text-btn" @click="emit('close')">稍后再说</button>
            <div class="join-actions-right">
              <button class="btn-primary" :disabled="busy" @click="submit">
                {{ busy ? '保存中…' : '保存昵称' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

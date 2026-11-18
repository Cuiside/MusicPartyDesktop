<script setup>
import { AlertTriangle } from 'lucide-vue-next'

defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '确认操作' },
  text: { type: String, default: '' },
  confirmLabel: { type: String, default: '确认' },
  danger: { type: Boolean, default: false }
})
const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="dialog-backdrop" @mousedown.self="emit('cancel')">
        <div class="dialog" role="alertdialog" aria-modal="true">
          <div class="dialog-head">
            <AlertTriangle :size="16" :stroke-width="1.8" class="dialog-icon" />
            <span class="dialog-title">{{ title }}</span>
          </div>
          <div class="dialog-body">{{ text }}</div>
          <div class="dialog-actions">
            <button class="btn-ghost" @click="emit('cancel')">取消</button>
            <button class="btn-primary" :class="{ danger }" @click="emit('confirm')">
              {{ confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

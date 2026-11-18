<script setup>
import { Loader2 } from 'lucide-vue-next'

defineProps({
  kind: { type: String, default: 'empty' },
  title: { type: String, required: true },
  text: { type: String, default: '' },
  actionLabel: { type: String, default: '' }
})

const emit = defineEmits(['action'])

const marks = {
  empty: '0',
  loading: '',
  error: '!',
  'no-results': '?'
}
</script>

<template>
  <div class="state-block" :class="kind">
    <div class="state-mark">
      <Loader2 v-if="kind === 'loading'" class="state-spinner" :size="18" :stroke-width="2" />
      <span v-else>{{ marks[kind] }}</span>
    </div>
    <div class="state-copy">
      <div class="state-title">{{ title }}</div>
      <div v-if="text" class="state-text">{{ text }}</div>
    </div>
    <button v-if="actionLabel" class="btn-ghost" @click="emit('action')">
      {{ actionLabel }}
    </button>
  </div>
</template>

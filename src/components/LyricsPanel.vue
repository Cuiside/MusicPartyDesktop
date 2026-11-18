<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  lines: { type: Array, required: true },
  progress: { type: Number, default: 0 }
})

const listEl = ref(null)

const active = computed(() => {
  let idx = 0
  for (let i = 0; i < props.lines.length; i++) {
    if (props.lines[i].t <= props.progress) idx = i
  }
  return idx
})

watch(
  active,
  async () => {
    await nextTick()
    const list = listEl.value
    const el = list?.children?.[active.value]
    if (!list || !el) return
    // Scroll only the lyrics container; scrollIntoView would also drag the
    // workspace (and the whole window) to the lyric line.
    const top = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  },
  { immediate: true }
)
</script>

<template>
  <div ref="listEl" class="lyrics">
    <p
      v-for="(line, i) in lines"
      :key="`${line.t}-${i}`"
      class="lyric-line"
      :class="{ active: i === active, past: i < active }"
    >
      <span>{{ line.text }}</span>
      <span v-if="line.trans" class="lyric-trans">{{ line.trans }}</span>
    </p>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  items: { type: Array, default: () => [] }
})
const emit = defineEmits(['select', 'close'])

const el = ref(null)
const pos = ref({ left: '0px', top: '0px' })

const place = () => {
  const pad = 8
  const width = 216
  const height = props.items.length * 32 + 10
  let left = props.x
  let top = props.y
  if (left + width > window.innerWidth - pad) left = window.innerWidth - width - pad
  if (top + height > window.innerHeight - pad) top = window.innerHeight - height - pad
  if (left < pad) left = pad
  if (top < pad) top = pad
  pos.value = { left: `${left}px`, top: `${top}px` }
}

const onDocDown = (e) => {
  if (el.value && !el.value.contains(e.target)) emit('close')
}
const onKey = (e) => {
  if (e.key === 'Escape') emit('close')
}

onMounted(async () => {
  await nextTick()
  place()
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div ref="el" class="ctxmenu" :style="pos" role="menu">
      <button
        v-for="item in items"
        :key="item.id"
        class="ctx-item"
        :class="{ danger: item.danger }"
        role="menuitem"
        @click="emit('select', item.id)"
      >
        <component
          :is="item.icon"
          v-if="item.icon"
          class="ctx-icon"
          :size="13"
          :stroke-width="1.8"
        />
        <span class="ctx-label">{{ item.label }}</span>
        <span v-if="item.shortcut" class="ctx-shortcut">{{ item.shortcut }}</span>
      </button>
    </div>
  </Teleport>
</template>

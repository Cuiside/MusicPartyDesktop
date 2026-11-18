<script setup>
import { computed, nextTick, ref } from 'vue'
import GeometricAvatar from './GeometricAvatar.vue'
import {
  Disc3,
  ListMusic,
  Search,
  MessageSquare,
  History,
  SlidersHorizontal
} from 'lucide-vue-next'
import { navItems } from '../core/demo'

const props = defineProps({
  modelValue: { type: String, default: 'party' },
  name: { type: String, default: '游客' }
})
const picker = ref(false)
const pickerEl = ref(null)
const accountEl = ref(null)
const closePicker = () => { picker.value = false; nextTick(() => accountEl.value?.focus()) }
const onPickerKey = event => {
  if (event.key === 'Escape') { event.preventDefault(); closePicker(); return }
  if (event.key !== 'Tab') return
  const buttons = [...(pickerEl.value?.querySelectorAll('button:not(:disabled)') || [])]
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement)
  if (event.shiftKey && index <= 0) { event.preventDefault(); buttons[buttons.length - 1].focus() }
  else if (!event.shiftKey && (index < 0 || index === buttons.length - 1)) { event.preventDefault(); buttons[0].focus() }
}
const choices = ['text', 'orbit', 'diamond', 'sun', 'wave', 'blocks']
const initial = computed(() => Array.from(props.name.trim() || '游客')[0])
const selected = ref((() => { try { return localStorage.getItem('mp.desktop.avatar') || 'text' } catch { return 'text' } })())
const choose = value => { selected.value = value; try { localStorage.setItem('mp.desktop.avatar', value) } catch {} ; closePicker() }
defineExpose({ openAvatarPicker: async () => { picker.value = true; await nextTick(); pickerEl.value?.querySelector('button')?.focus() } })
const emit = defineEmits(['update:modelValue', 'account'])

const icons = {
  party: Disc3,
  queue: ListMusic,
  search: Search,
  chat: MessageSquare,
  history: History,
  console: SlidersHorizontal
}
</script>

<template>
  <nav class="navrail">
    <button
      v-for="item in navItems"
      :key="item.id"
      class="nav-item"
      :class="{ active: modelValue === item.id }"
      :title="item.label"
      @click="emit('update:modelValue', item.id)"
    >
      <component :is="icons[item.id]" :size="20" :stroke-width="1.6" />
      <span class="nav-label">{{ item.label }}</span>
    </button>

    <div class="nav-spacer"></div>

    <button ref="accountEl" class="nav-account" title="账户菜单" @click="emit('account')">
      <span class="avatar-ring"></span>
      <span class="avatar"><template v-if="selected === 'text' || !choices.includes(selected)">{{ initial }}</template><GeometricAvatar v-else :kind="selected" /></span>
    </button>
    <Teleport to="body"><div v-if="picker" class="avatar-backdrop" @click.self="closePicker" @keydown="onPickerKey"><section ref="pickerEl" class="avatar-picker" role="dialog" aria-modal="true" aria-label="选择头像"><h2>选择头像</h2><p>头像仅保存在本机，不会同步给其他成员。</p><div class="avatar-choices"><button v-for="choice in choices" :key="choice" :aria-label="choice === 'text' ? '昵称首字' : `几何头像 ${choice}`" :aria-pressed="selected === choice" @click="choose(choice)"><template v-if="choice === 'text'">{{ initial }}</template><GeometricAvatar v-else :kind="choice" /></button></div><button class="btn-ghost" @click="closePicker">取消</button></section></div></Teleport>
  </nav>
</template>

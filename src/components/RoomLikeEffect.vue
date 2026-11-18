<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Heart } from 'lucide-vue-next'
import { onRoomLike } from '../core/live/transport.js'
import { live } from '../core/live/state.js'
import { session } from '../core/live/session.js'
const items = ref([])
const timers = new Map()
let seq = 0, unsubscribe = () => {}
const clear = () => { items.value = []; for (const timer of timers.values()) clearTimeout(timer); timers.clear() }
watch(() => [session.generation, live.joined], ([generation, joined], previous) => {
  if (previous && (generation !== previous[0] || (!joined && previous[1]))) clear()
})
onMounted(() => {
  unsubscribe = onRoomLike(event => {
    const id = ++seq
    items.value = [...items.value, { id, ...event }].slice(-4)
    const timer = setTimeout(() => { items.value = items.value.filter(item => item.id !== id); timers.delete(id) }, 3200)
    timers.set(id, timer)
  })
})
onBeforeUnmount(() => { unsubscribe(); clear() })
</script>
<template>
  <Teleport to="body"><div class="room-like-effects" aria-live="polite"><TransitionGroup name="room-like"><div v-for="item in items" :key="item.id" class="room-like-card"><Heart class="room-like-heart" :size="25" fill="currentColor" /><div><strong>{{ item.message }}</strong><small v-if="item.song">{{ item.song }}</small></div></div></TransitionGroup></div></Teleport>
</template>
<style scoped>
.room-like-effects{position:fixed;top:76px;right:24px;z-index:2000;display:flex;flex-direction:column;gap:8px;max-width:min(340px,80vw);pointer-events:none}.room-like-card{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid #efb0b8;border-radius:12px;background:rgba(255,248,249,.96);color:#54242e;box-shadow:0 6px 24px #0003;overflow:hidden}.room-like-card div{min-width:0}.room-like-card strong,.room-like-card small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.room-like-card small{margin-top:3px;color:#85545d}.room-like-heart{color:#e53d56;flex:none;animation:heartbeat .65s ease both}@keyframes heartbeat{0%{transform:scale(.4)}45%{transform:scale(1.2)}70%{transform:scale(.9)}100%{transform:scale(1)}}.room-like-enter-active,.room-like-leave-active{transition:opacity .25s,transform .25s}.room-like-enter-from,.room-like-leave-to{opacity:0;transform:translateY(-10px)}@media(prefers-reduced-motion:reduce){.room-like-heart{animation:none}.room-like-enter-active,.room-like-leave-active{transition:none}}
</style>

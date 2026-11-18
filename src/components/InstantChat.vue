<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Send } from 'lucide-vue-next'
import TrackCover from './TrackCover.vue'

const props = defineProps({ messages: { type: Array, default: () => [] }, sendMessage: { type: Function, required: true } })
const emit = defineEmits(['add', 'find'])
const showSystem = ref(false), showPlaybackHistory = ref(false), draft = ref(''), scroller = ref(null), sending = ref(false)
const visible = computed(() => props.messages.filter(m => m.type === 'song' ? showPlaybackHistory.value : (showSystem.value || m.type === 'chat')))
const scrollBottom = async () => { await nextTick(); if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight }
watch(() => visible.value.map(m => m.id).join('|'), scrollBottom)
onMounted(scrollBottom)
const send = async () => {
  const text = draft.value.trim()
  if (!text || sending.value) return
  sending.value = true
  try { if (await props.sendMessage(text) && draft.value.trim() === text) draft.value = '' }
  finally { sending.value = false }
}
</script>
<template>
  <section class="instant-chat" aria-label="即时聊天">
    <div class="instant-chat-title"><strong>即时聊天</strong><span>{{ visible.length }} 条</span></div>
    <div ref="scroller" class="instant-chat-scroll" role="log" aria-live="polite">
      <div v-for="m in visible" :key="m.id" class="instant-row">
        <small>{{ m.time }}</small>
        <template v-if="m.type === 'song'">
          <div class="instant-song"><span class="instant-author">SYSTEM</span><div class="instant-song-body">
            <div v-if="m.song?.cover" class="instant-cover"><TrackCover :cover="m.song.cover" small /></div>
            <span class="instant-song-name"><b>{{ m.song?.title || m.text }}</b><small>{{ m.song?.artist || '' }}</small></span>
            <button v-if="m.song?.id" class="btn-ghost" @click="emit('add', m.song)">点歌</button>
            <button v-else-if="m.song?.title" class="btn-ghost" title="旧记录没有歌曲 ID，请搜索后选择正确歌曲" @click="emit('find', m.song.title)">搜索点歌</button>
            <button v-else class="btn-ghost" disabled title="旧记录没有歌曲信息">无法点歌</button>
          </div></div>
        </template>
        <div v-else-if="m.type === 'system'" class="instant-system">{{ m.text }}</div>
        <div v-else class="instant-message"><b>{{ m.user || '成员' }}</b><span>{{ m.text }}</span></div>
      </div>
      <p v-if="!visible.length" class="instant-empty">还没有聊天消息，来打个招呼吧。</p>
    </div>
    <div class="instant-toggles">
      <label class="instant-toggle"><input v-model="showSystem" type="checkbox" /><span>显示系统日志 <small>勾选之后显示日志</small></span></label>
      <label class="instant-toggle"><input v-model="showPlaybackHistory" type="checkbox" /><span>显示播放记录 <small>勾选之后显示歌曲卡片</small></span></label>
    </div>
    <form class="instant-compose" @submit.prevent="send"><input v-model="draft" placeholder="发送消息…" aria-label="聊天消息" maxlength="200" /><button class="btn-primary" type="submit" :disabled="!draft.trim() || sending"><Send :size="13" /> {{ sending ? '发送中…' : '发送' }}</button></form>
  </section>
</template>
<style scoped>
.instant-toggles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.instant-toggles .instant-toggle{min-width:0}.instant-toggles .instant-toggle input{flex:none}.instant-toggles .instant-toggle span{min-width:0;overflow-wrap:anywhere}
.instant-chat{display:flex;flex-direction:column;min-height:0;height:100%;padding:12px;gap:10px}.instant-chat-title{display:flex;justify-content:space-between;font-size:12px}.instant-chat-title span,.instant-row>small{font-size:10px;color:var(--muted)}.instant-chat-scroll{overflow-y:auto;flex:1;min-height:180px}.instant-row{display:flex;gap:8px;padding:9px 0;border-bottom:1px solid var(--line)}.instant-row>small{flex:none;width:34px}.instant-message,.instant-song{min-width:0;flex:1;font-size:12px}.instant-message b,.instant-author{display:block;margin-bottom:4px}.instant-message span,.instant-system{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.instant-system{color:var(--muted)}.instant-song-body{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--line)}.instant-cover{width:32px;height:32px;flex:none}.instant-song-name{min-width:0;flex:1;overflow-wrap:anywhere}.instant-song-name small{display:block;color:var(--muted)}.instant-empty{color:var(--muted);font-size:12px}.instant-toggle{display:flex;align-items:center;gap:7px;font-size:12px}.instant-toggle input{appearance:none;width:16px;height:16px;border:1px solid #777;border-radius:50%;margin:0}.instant-toggle input:checked{border:5px solid #141414;background:#ffcd38}.instant-toggle small{display:block;color:var(--muted);font-size:10px}.instant-compose{display:flex;gap:6px}.instant-compose input{min-width:0;flex:1;border:1px solid #bbb;padding:8px}.instant-compose button{white-space:nowrap}
</style>

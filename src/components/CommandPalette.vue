<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { Search, Plus } from 'lucide-vue-next'
import TrackCover from './TrackCover.vue'
import { search } from '../core/live/client'
import { demo } from '../core/demo'

const props = defineProps({ open: Boolean, items: { type: Array, default: () => [] }, live: Boolean, initialQuery: { type: String, default: '' } })
const emit = defineEmits(['close', 'select', 'add'])
const codes = { settings:'settings', demo:'demo', resync:'resync', disconnect:'disconnect', connect:'connect', welcome:'welcome', 'go-party':'party', 'go-queue':'queue', 'go-search':'search', 'go-chat':'chat', 'go-history':'history', 'go-console':'console', 'local-mute':'mute', 'toggle-play':'play', 'stream-help':'stream', tour:'help', 'admin-auth':'admin', 'open-admin-console':'admin', 'clear-queue':'clear' }
const query = ref(''), active = ref(0), inputEl = ref(null), platform = ref('netease'), composing = ref(false)
const forcedSearch = ref(false)
const results = ref([]), loading = ref(false), error = ref('')
let timer, sequence = 0
const isCommand = computed(() => !forcedSearch.value && /^\/[a-z-]*$/i.test(query.value.trim()))
const filtered = computed(() => {
  if (!isCommand.value) return []
  const q = query.value.trim().slice(1).toLowerCase()
  return props.items.filter(item => (codes[item.id] || item.id).includes(q))
})
async function runSearch() {
  const seq = ++sequence, term = query.value.trim(), source = platform.value
  error.value = ''; results.value = []; loading.value = false
  if (!props.open || !term || isCommand.value || composing.value) return
  loading.value = true
  try {
    const songs = props.live ? await search(source, term) : demo.searchResults.filter(s => `${s.title} ${s.artist}`.toLowerCase().includes(term.toLowerCase()) && s.source === source)
    if (seq === sequence) results.value = songs
  } catch (e) { if (seq === sequence) error.value = e.message || '搜索失败' }
  finally { if (seq === sequence) loading.value = false }
}
watch(() => [props.open, query.value, platform.value, props.live, composing.value], () => {
  clearTimeout(timer); sequence++; results.value = []; error.value = ''; active.value = 0
  if (props.open && query.value.trim() && !isCommand.value && !composing.value) timer = setTimeout(runSearch, 250)
  else loading.value = false
})
watch(() => props.open, async open => { if (open) { forcedSearch.value = !!props.initialQuery; query.value = props.initialQuery; platform.value = 'netease'; await nextTick(); inputEl.value?.focus() } }, { immediate: true })
const choose = index => {
  if (isCommand.value) { const item = filtered.value[index]; if (item) { emit('select', item); emit('close') } }
  else { const song = results.value[index]; if (song) emit('add', song) }
}
const onKey = event => {
  if (event.isComposing || event.keyCode === 229 || composing.value) { event.stopPropagation(); return }
  const length = isCommand.value ? filtered.value.length : results.value.length
  if (event.key === 'ArrowDown') { event.preventDefault(); active.value = length ? (active.value + 1) % length : 0 }
  else if (event.key === 'ArrowUp') { event.preventDefault(); active.value = length ? (active.value - 1 + length) % length : 0 }
  else if (event.key === 'Enter') { event.preventDefault(); choose(active.value) }
  else if (event.key === 'Escape') { event.preventDefault(); emit('close') }
}
</script>
<template>
  <Teleport to="body"><Transition name="palette"><div v-if="open" class="palette-backdrop" @mousedown.self="emit('close')">
    <div class="palette" role="dialog" aria-label="搜索与命令" aria-modal="true">
      <div class="palette-input"><Search :size="16" /><input ref="inputEl" v-model="query" placeholder="搜索歌曲或歌手；输入 / 查看命令…" spellcheck="false" @input="forcedSearch = false" @compositionstart="composing = true" @compositionend="composing = false" @keydown="onKey" /><span class="kbd">ESC</span></div>
      <div v-if="!isCommand" class="palette-sources" aria-label="搜索来源">
        <button v-for="source in ['netease','bilibili']" :key="source" type="button" class="chip-link" :class="{ active: platform === source }" @click="platform = source">{{ source === 'netease' ? '网易云音乐' : 'Bilibili' }}</button>
      </div>
      <div class="palette-list">
        <template v-if="isCommand"><template v-for="(item, i) in filtered" :key="item.id">
          <div v-if="i === 0 || filtered[i - 1].group !== item.group" class="palette-group">{{ item.group }}</div>
          <button class="palette-item" :class="{ active: i === active, danger: item.danger }" @mouseenter="active = i" @click="choose(i)">
            <component :is="item.icon" v-if="item.icon" class="palette-icon" :size="14" /><span class="palette-label">/{{ codes[item.id] || item.id }}</span><span class="palette-desc">{{ item.label }} · {{ item.desc }}</span><span v-if="item.shortcut" class="kbd">{{ item.shortcut }}</span>
          </button>
        </template><div v-if="!filtered.length" class="palette-empty">没有匹配的命令</div></template>
        <template v-else><div v-if="loading" class="palette-empty">正在搜索…</div><div v-else-if="error" class="palette-empty" role="alert">{{ error }}</div>
          <div v-else-if="!query.trim()" class="palette-empty">输入歌曲或歌手名称开始搜索；输入 / 查看命令。</div>
          <template v-else><div v-for="(song, i) in results" :key="song.source + ':' + song.id" class="palette-song" :class="{ active: i === active }" @mouseenter="active = i">
            <div class="palette-cover"><TrackCover :cover="song.cover" small /></div><span class="palette-song-meta"><b>{{ song.title }}</b><small>{{ song.artist }}</small></span><button class="btn-ghost" type="button" @click.stop="emit('add', song)"><Plus :size="12" /> 点歌</button>
          </div><div v-if="!results.length" class="palette-empty">没有找到结果，请尝试其他关键词或来源。</div></template>
        </template>
      </div><div class="palette-foot"><span class="palette-hint"><span class="kbd">↑↓</span> 选择</span><span class="palette-hint"><span class="kbd">↵</span> {{ isCommand ? '执行命令' : '点歌' }}</span><span class="palette-hint"><span class="kbd">ESC</span> 关闭</span></div>
    </div>
  </div></Transition></Teleport>
</template>
<style scoped>
.palette-sources { display:flex; gap:8px; padding:10px 16px; border-bottom:1px solid #ddd; }
.palette-sources .chip-link { color:var(--ink-2); } .palette-sources .chip-link.active { color:#ffcd38; background:#141414; border-color:var(--ink-2); }
.palette-song { display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid var(--line); }
.palette-song.active { background:#f1f1ef; } .palette-cover { width:36px; height:36px; flex:none; }.palette-song-meta { flex:1; min-width:0; }.palette-song-meta b,.palette-song-meta small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.palette-song-meta small { font-size:11px; color:var(--muted); }
</style>

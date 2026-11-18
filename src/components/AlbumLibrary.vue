<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { getSongAlbum, getPlaylistSongs } from '../core/live/api'
import { importPlaylist } from '../core/live/client'
import { estimateImportDuplicates } from '../core/live/import-notice'
import DuplicateImportDialog from './DuplicateImportDialog.vue'
import { live } from '../core/live/state'

const props = defineProps({ track: { type: Object, required: true } })
const emit = defineEmits(['close', 'add', 'select'])
const album = ref(null), songs = ref([]), cursor = ref(null), busy = ref(false), error = ref(''), message = ref('')
const duplicateNotice = ref(null)
let generation = 0
const valid = (seq, base) => seq === generation && live.joined && live.sessionBase === base

async function load(track) {
  const seq = ++generation, base = live.sessionBase
  album.value = null; songs.value = []; cursor.value = null; error.value = ''; message.value = ''; busy.value = true
  try {
    const found = await getSongAlbum(track.source, track.id)
    if (!valid(seq, base)) return
    const page = await getPlaylistSongs(track.source, found.id, 0, 50, 'album')
    if (!valid(seq, base)) return
    album.value = found; songs.value = page.songs; cursor.value = page.nextCursor
  } catch (e) { if (valid(seq, base)) error.value = e.message || '读取专辑失败' }
  finally { if (valid(seq, base)) busy.value = false }
}
async function more() {
  if (!cursor.value || busy.value || !album.value) return
  const seq = ++generation, base = live.sessionBase, before = cursor.value
  busy.value = true; error.value = ''
  try {
    const page = await getPlaylistSongs(props.track.source, album.value.id, before, 50, 'album')
    if (!valid(seq, base)) return
    if (page.nextCursor && page.nextCursor === before) throw new Error('专辑分页未前进')
    songs.value = [...songs.value, ...page.songs]; cursor.value = page.nextCursor
  } catch (e) { if (valid(seq, base)) error.value = e.message || '加载失败' }
  finally { if (valid(seq, base)) busy.value = false }
}
async function addAll() {
  if (!album.value || busy.value) return
  const seq = ++generation, base = live.sessionBase
  busy.value = true; error.value = ''; message.value = ''
  try {
    const tracks = await estimateImportDuplicates(props.track.source, album.value.id, 'album')
    if (!valid(seq, base)) return
    const result = await importPlaylist(props.track.source, album.value.id, 'album')
    if (!valid(seq, base)) return
    if (result.ok && result.confirmed && result.duplicates > 0) duplicateNotice.value = { count: result.duplicates, tracks }
    if (!result.ok) error.value = result.message || result.reason || '导入失败'
    else message.value = result.confirmed ? (result.message || '专辑已导入') : '导入请求已发送，等待房间确认'
  } catch (e) { if (valid(seq, base)) error.value = e.message || '导入失败' }
  finally { if (valid(seq, base)) busy.value = false }
}
watch(() => [props.track.id, props.track.source, live.sessionBase], () => { void load(props.track) }, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <section class="album-library panel" aria-label="专辑详情">
    <div class="panel-head"><span class="label">{{ album?.name || '专辑详情' }}</span><button class="text-btn" @click="emit('close')">关闭</button></div>
    <p v-if="busy && !album" class="album-note">正在读取专辑…</p>
    <template v-if="album">
      <div class="album-toolbar"><span>共 {{ album.trackCount }} 首 · 已加载 {{ songs.length }} 首</span><button class="btn-primary" :disabled="busy" @click="addAll">导入专辑</button></div>
      <div v-for="song in songs" :key="`${song.source}:${song.id}`" class="album-song" @click="emit('select', song)">
        <span>{{ song.title }} · {{ song.artist }}</span><button class="btn-ghost" @click.stop="emit('add', song)">点歌</button>
      </div>
      <button v-if="cursor" class="btn-ghost" :disabled="busy" @click="more">加载更多</button>
    </template>
    <p v-if="error" class="album-note" role="alert">{{ error }}</p>
    <p v-if="message" class="album-note" role="status">{{ message }}</p>
    <DuplicateImportDialog v-if="duplicateNotice" :count="duplicateNotice.count" :tracks="duplicateNotice.tracks" @close="duplicateNotice = null" />
  </section>
</template>
<style scoped>
.album-library { margin-bottom:20px; padding-bottom:12px; }
.album-toolbar,.album-song { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 14px; }
.album-song { border-top:1px solid var(--line); }
.album-note { padding:10px 14px; color:var(--ink); }
</style>

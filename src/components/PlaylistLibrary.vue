<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { searchUsers, getUserPlaylists, getPlaylistSongs } from '../core/live/api'
import { importPlaylist } from '../core/live/client'
import { estimateImportDuplicates } from '../core/live/import-notice'
import DuplicateImportDialog from './DuplicateImportDialog.vue'
import { live } from '../core/live/state'
import { readLocalBindings, saveLocalBinding } from '../core/live/local-bindings'
import TrackCover from './TrackCover.vue'

const props = defineProps({ platform: { type: String, required: true } })
const emit = defineEmits(['add', 'select'])
const bindings = ref(readLocalBindings())
const boundUser = computed(() => bindings.value[props.platform] || null)
const keyword = ref('')
const users = ref([])
const playlists = ref([])
const songs = ref([])
const selected = ref(null)
const busy = ref('')
const error = ref('')
const message = ref('')
const offset = ref(0)
const hasMore = ref(false)
const pageSize = computed(() => props.platform === 'bilibili' ? 20 : 50)
const duplicateNotice = ref(null)
let generation = 0

const clearView = () => {
  playlists.value = []; songs.value = []; users.value = []; selected.value = null
  offset.value = 0; hasMore.value = false; error.value = ''; message.value = ''
}
const valid = (seq, source, base) => seq === generation && source === props.platform && base === live.sessionBase && live.joined

async function loadPlaylists() {
  const seq = ++generation, source = props.platform, base = live.sessionBase
  clearView()
  if (!boundUser.value || !live.joined) { busy.value = ''; return }
  busy.value = 'playlists'
  try {
    const rows = await getUserPlaylists(source, boundUser.value.id)
    if (valid(seq, source, base)) playlists.value = rows
  } catch (e) { if (valid(seq, source, base)) error.value = e.message || '获取歌单失败' }
  finally { if (valid(seq, source, base)) busy.value = '' }
}

async function findUsers() {
  const term = keyword.value.trim()
  if (!term || busy.value) return
  const seq = ++generation, source = props.platform, base = live.sessionBase
  error.value = ''; message.value = ''; users.value = []; busy.value = 'users'
  try {
    const rows = await searchUsers(source, term)
    if (valid(seq, source, base)) { users.value = rows; if (!rows.length) message.value = '没有找到用户，请更换关键词。' }
  } catch (e) { if (valid(seq, source, base)) error.value = e.message || '搜索用户失败' }
  finally { if (valid(seq, source, base)) busy.value = '' }
}

function bind(user) {
  bindings.value = saveLocalBinding(props.platform, user)
  keyword.value = ''
  void loadPlaylists()
}
function unbind() {
  ++generation
  bindings.value = saveLocalBinding(props.platform, null)
  clearView(); busy.value = ''
}

async function loadSongs(playlist, append = false) {
  if (busy.value) return
  const seq = ++generation, source = props.platform, base = live.sessionBase
  if (!append) { selected.value = playlist; songs.value = []; offset.value = 0; hasMore.value = false }
  const nextOffset = offset.value
  error.value = ''; message.value = ''; busy.value = 'songs'
  try {
    const page = await getPlaylistSongs(source, playlist.id, nextOffset, pageSize.value, playlist.collectionType)
    if (!valid(seq, source, base) || selected.value?.id !== playlist.id) return
    songs.value = append ? [...songs.value, ...page.songs] : page.songs
    offset.value = page.nextCursor
    hasMore.value = page.nextCursor != null
  } catch (e) { if (valid(seq, source, base)) error.value = e.message || '获取歌曲失败' }
  finally { if (valid(seq, source, base)) busy.value = '' }
}

async function addAll() {
  if (!selected.value || busy.value) return
  const seq = ++generation, source = props.platform, base = live.sessionBase
  const playlistId = selected.value.id
  error.value = ''; message.value = ''; busy.value = 'import'
  try {
    const tracks = await estimateImportDuplicates(source, playlistId, selected.value.collectionType)
    if (!valid(seq, source, base)) return
    const result = await importPlaylist(source, playlistId, selected.value.collectionType)
    if (!valid(seq, source, base)) return
    if (result.ok && result.confirmed && result.duplicates > 0) duplicateNotice.value = { count: result.duplicates, tracks }
    if (!result.ok) error.value = result.reason || result.message || '导入失败'
    else message.value = result.confirmed
      ? (result.message || '服务器已处理导入请求，请查看队列。')
      : '导入请求已发送，服务器尚未确认；请查看队列。'
  } catch (e) { if (valid(seq, source, base)) error.value = e.message || '导入失败' }
  finally { if (valid(seq, source, base)) busy.value = '' }
}

watch(() => [props.platform, live.sessionBase, live.joined], () => { void loadPlaylists() }, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <section class="playlist-library panel" aria-label="我的用户歌单">
    <div class="panel-head"><span class="label">我的用户歌单 · {{ ({netease: '网易云', bilibili: 'Bilibili', qqmusic: 'QQ音乐'})[platform] || platform }}</span></div>
    <p class="playlist-privacy">绑定只保存在当前电脑的客户端配置中，不会广播给房间成员。歌单可见范围取决于房间音源账号的权限。</p>
    <div class="playlist-layout">
      <div class="playlist-sidebar">
        <template v-if="!boundUser">
          <label class="playlist-label" for="playlist-user-search">搜索用户名并绑定</label>
          <form class="playlist-user-form" @submit.prevent="findUsers">
            <input id="playlist-user-search" v-model="keyword" placeholder="输入用户名" maxlength="100" />
            <button class="btn-primary" type="submit" :disabled="!!busy || !keyword.trim()">{{ busy === 'users' ? '搜索中…' : '搜索' }}</button>
          </form>
          <div v-for="user in users" :key="user.id" class="playlist-user-row">
            <span>{{ user.name }} <small>ID: {{ user.id }}</small></span>
            <button class="btn-ghost" :disabled="!!busy" @click="bind(user)">绑定</button>
          </div>
        </template>
        <template v-else>
          <div class="playlist-bound"><span>已绑定：<strong>{{ boundUser.name }}</strong><small>ID: {{ boundUser.id }}</small></span>
            <button class="btn-ghost" @click="unbind">解除绑定</button></div>
          <p v-if="busy === 'playlists'" class="playlist-hint">正在获取歌单…</p>
          <p v-else-if="!playlists.length && !error" class="playlist-hint">没有可见歌单。可检查该账号和房间音源权限。</p>
          <button v-for="playlist in playlists" :key="playlist.id" class="playlist-entry" :class="{ active: selected?.id === playlist.id }"
            :disabled="!!busy" @click="loadSongs(playlist)">
            <img v-if="playlist.coverImgUrl" :src="playlist.coverImgUrl" alt="" referrerpolicy="no-referrer" />
            <span class="playlist-name">{{ playlist.name }}<small>{{ playlist.trackCount }} 首</small></span>
          </button>
          <button class="text-btn playlist-refresh" :disabled="!!busy" @click="loadPlaylists">刷新歌单</button>
        </template>
      </div>
      <div class="playlist-tracks">
        <template v-if="selected">
          <div class="playlist-track-head">
            <span><strong>{{ selected.name }}</strong><small>已加载 {{ songs.length }} 首 · 歌单共 {{ selected.trackCount }} 首</small></span>
            <button class="btn-primary" :disabled="!!busy" @click="addAll">{{ busy === 'import' ? '正在导入…' : '导入全部' }}</button>
          </div>
          <p class="playlist-hint">导入数量受房间队列与管理员设置限制<span v-if="platform === 'bilibili'">；B站收藏夹当前服务端单次最多处理20首</span>。</p>
          <div v-for="song in songs" :key="`${song.source}:${song.id}`" class="playlist-song" @click="emit('select', song)">
            <div class="playlist-cover"><TrackCover :cover="song.cover" small /></div>
            <span class="playlist-name">{{ song.title }}<small>{{ song.artist }}</small></span>
            <button class="btn-ghost" @click.stop="emit('add', song)">点歌</button>
          </div>
          <p v-if="busy === 'songs'" class="playlist-hint">正在加载歌曲…</p>
          <p v-else-if="!songs.length && !error" class="playlist-hint">歌单中没有可显示的歌曲。</p>
          <button v-if="hasMore" class="btn-ghost playlist-more" :disabled="!!busy" @click="loadSongs(selected, true)">加载更多</button>
        </template>
        <p v-else class="playlist-hint">{{ boundUser ? '从左侧选择歌单查看歌曲。' : '绑定用户后可查看歌单及导入歌曲。' }}</p>
      </div>
    </div>
    <p v-if="error" class="playlist-notice error" role="alert">{{ error }}</p>
    <p v-if="message" class="playlist-notice" role="status">{{ message }}</p>
    <DuplicateImportDialog v-if="duplicateNotice" :count="duplicateNotice.count" :tracks="duplicateNotice.tracks" @close="duplicateNotice = null" />
  </section>
</template>

<style scoped>
.playlist-library { margin-bottom: 20px; }
.playlist-privacy, .playlist-hint { color: var(--muted); font-size: 12px; line-height: 1.6; margin: 10px 14px; }
.playlist-layout { display: grid; grid-template-columns: minmax(220px, 30%) minmax(0, 1fr); border-top: 1px solid #e5e5e5; min-height: 150px; }
.playlist-sidebar { border-right: 1px solid #e5e5e5; padding: 12px; max-height: 410px; overflow: auto; }
.playlist-tracks { padding: 12px; max-height: 410px; overflow: auto; }
.playlist-label { display: block; font-size: 12px; margin-bottom: 8px; }
.playlist-user-form, .playlist-bound, .playlist-user-row, .playlist-track-head, .playlist-song { display: flex; gap: 10px; align-items: center; }
.playlist-user-form input { min-width: 0; flex: 1; padding: 9px; border: 1px solid #ccc; }
.playlist-bound, .playlist-track-head { justify-content: space-between; margin-bottom: 10px; }
.playlist-bound button, .playlist-track-head button { white-space: nowrap; flex: none; }
.playlist-bound span, .playlist-track-head span, .playlist-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.playlist-user-row { justify-content: space-between; border-bottom: 1px solid var(--line); padding: 8px 0; }
small { display: block; color: var(--muted-2); font-size: 11px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; }
.playlist-entry { display: flex; width: 100%; gap: 10px; align-items: center; background: transparent; border: 0; border-left: 2px solid transparent; text-align: left; padding: 8px; cursor: pointer; }
.playlist-entry:hover, .playlist-entry.active { background: #f3f3f3; border-left-color: var(--ink-2); }
.playlist-entry img, .playlist-cover { width: 38px; height: 38px; object-fit: cover; flex: none; }
.playlist-refresh, .playlist-more { margin-top: 10px; }
.playlist-song { border-top: 1px solid var(--line); padding: 8px 0; cursor: pointer; }
.playlist-song .playlist-name { flex: 1; }
.playlist-notice { font-size: 12px; padding: 10px 14px; background: #f2f2f2; }
.playlist-notice.error { color: #a42d28; }
@media (max-width: 800px) { .playlist-layout { grid-template-columns: 1fr; } .playlist-sidebar { border-right: 0; border-bottom: 1px solid #ddd; max-height: 230px; } }
</style>

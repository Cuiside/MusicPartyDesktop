<script setup>
import { computed, ref } from 'vue'
import TrackCover from '../components/TrackCover.vue'
import { toSong } from '../core/live/mapping.js'
import { useLikedSongs } from '../core/local-likes.js'

const emit = defineEmits(['add', 'select', 'error'])
const { likedSongs, removeLikedSong } = useLikedSongs()
const query = ref('')
const rows = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return likedSongs.value.filter(item => item && item.id != null && item.platform)
    .map(item => ({ item, song: toSong(item) }))
    .filter(({ song }) => !term || `${song.title} ${song.artist} ${song.sourceLabel}`.toLocaleLowerCase().includes(term))
})
const fmt = seconds => {
  if (!seconds) return '—'
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const sourceUrl = item => {
  try { const u = new URL(String(item.externalUrl || '')); if (u.protocol === 'https:' || u.protocol === 'http:') return u.href } catch {}
  if (item.platform === 'netease' && /^\d+$/.test(String(item.id))) return 'https://music.163.com/#/song?id=' + encodeURIComponent(item.id)
  if (item.platform === 'bilibili' && /^BV[0-9A-Za-z]+$/.test(String(item.id))) return 'https://www.bilibili.com/video/' + encodeURIComponent(item.id)
  return ''
}
const remove = item => { if (!removeLikedSong(item.platform, item.id)) emit('error', '本机收藏移除失败，请检查存储空间') }
</script>

<template>
  <div class="workspace"><div class="workspace-inner">
    <section class="panel likes" aria-label="本机点赞歌曲">
      <div class="panel-head"><span class="label">本机点赞歌曲 · LIKESONG</span><span class="label">仅保存在当前浏览器 · {{ likedSongs.length }} 首</span></div>
      <div class="likes-content">
        <label class="likes-search"><span>搜索收藏</span><input v-model="query" type="search" placeholder="歌曲、歌手或来源" /></label>
        <p v-if="!likedSongs.length" class="likes-empty">还没有本机收藏的歌曲。</p>
        <p v-else-if="!rows.length" class="likes-empty">没有匹配的歌曲。</p>
        <ul v-else class="likes-list">
          <li v-for="{ item, song } in rows" :key="`${item.platform}:${item.id}`" class="likes-row">
            <button type="button" class="likes-track" @click="emit('select', song)"><TrackCover :cover="song.cover" small /><span class="likes-meta"><strong>{{ song.title }}</strong><small>{{ song.artist }} · {{ song.sourceLabel }} · {{ fmt(song.duration) }}</small></span></button>
            <div class="likes-actions"><button type="button" class="btn-ghost" @click="emit('add', song)">重新点歌</button><a v-if="sourceUrl(item)" class="btn-ghost" :href="sourceUrl(item)" target="_blank" rel="noopener noreferrer">打开来源</a><button type="button" class="btn-ghost" :aria-label="`移除收藏 ${song.title}`" @click="remove(item)">移除收藏</button></div>
          </li>
        </ul>
        <p class="likes-note">收藏仅属于此浏览器的本地存储，不会同步到服务器或其他浏览器。</p>
      </div>
    </section>
  </div></div>
</template>

<style scoped>
.likes-content { padding: 20px; }
.likes-search { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.likes-search input { flex: 1; min-width: 180px; padding: 9px 12px; color: inherit; background: transparent; border: 1px solid var(--border, #777); border-radius: 6px; }
.likes-list { list-style: none; padding: 0; margin: 16px 0; }
.likes-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border, #777); }
.likes-track { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; text-align: left; color: inherit; background: transparent; border: 0; cursor: pointer; }
.likes-meta { min-width: 0; display: grid; gap: 4px; }
.likes-meta strong, .likes-meta small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.likes-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.likes-empty, .likes-note { opacity: .7; }
.likes-note { font-size: 12px; }
@media (max-width: 600px) { .likes-row { align-items: flex-start; flex-direction: column; } .likes-track { width: 100%; } }
</style>

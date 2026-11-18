// Browser-local likes, independent of room likes.
import { ref } from 'vue'
export const LIKED_SONGS_KEY = 'mp_liked_songs'
export const likedSongs = ref([])
let loaded = false
function load() {
  if (loaded) return
  loaded = true
  try {
    const data = JSON.parse(localStorage.getItem(LIKED_SONGS_KEY) || '[]')
    likedSongs.value = Array.isArray(data) ? data : []
  } catch { likedSongs.value = [] }
}
function persist() {
  try { localStorage.setItem(LIKED_SONGS_KEY, JSON.stringify(likedSongs.value)); return true } catch { return false }
}
const same = (song, platform, id) => String(song.platform ?? '') === String(platform ?? '') && String(song.id ?? '') === String(id ?? '')
export function isLiked(platform, id) {
  load()
  return likedSongs.value.some(song => song && same(song, platform, id))
}
// Web Music duration is milliseconds; desktop toSong duration is seconds.
export function addLikedSong(song) {
  load()
  if (!song || song.id == null || String(song.id) === '') return false
  const platform = song.platform ?? song.source
  if (!platform) return false
  if (isLiked(platform, song.id)) return true
  const desktop = song.platform == null && song.source != null
  const duration = Number(desktop ? Number(song.fullDuration ?? song.duration) * 1000 : song.duration)
  const artists = Array.isArray(song.artists) ? song.artists : (song.artist ? [song.artist] : [])
  likedSongs.value.unshift({ id: song.id, platform, name: song.name ?? song.title ?? '', artists,
    coverUrl: song.coverUrl ?? song.cover?.url ?? '', externalUrl: song.externalUrl ?? '',
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}) })
  if (!persist()) { likedSongs.value.shift(); return false }
  return true
}
export function removeLikedSong(platform, id) {
  load()
  const previous = likedSongs.value
  likedSongs.value = likedSongs.value.filter(song => !song || !same(song, platform, id))
  if (!persist()) { likedSongs.value = previous; return false }
  return true
}
export function useLikedSongs() {
  load()
  return { likedSongs, isLiked, addLikedSong, removeLikedSong }
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== LIKED_SONGS_KEY && event.key !== null) return
  loaded = false
  load()
})

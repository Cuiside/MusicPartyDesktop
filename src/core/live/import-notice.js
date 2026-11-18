import { getPlaylistSongs } from './api.js'
import { live } from './state.js'

// The server reports only a count, so these names are necessarily estimates.
export async function estimateImportDuplicates(source, id, type) {
  const base = live.sessionBase
  const max = Math.max(1, Math.min(1000, Number(live.config.maxPlaylistImportSize) || 100))
  const tracks = [], cursors = new Set()
  let cursor = 0
  try {
    do {
      const page = await getPlaylistSongs(source, id, cursor, source === 'bilibili' ? 20 : 50, type)
      if (!live.joined || live.sessionBase !== base) return []
      tracks.push(...page.songs)
      cursor = page.nextCursor
      if (cursor == null || cursors.has(String(cursor))) break
      cursors.add(String(cursor))
    } while (tracks.length < max && cursors.size < 51)
  } catch { return [] }
  const key = song => song.source + ':' + song.id
  const existing = new Set(live.queue.map(key))
  return tracks.slice(0, max).filter(song => existing.has(key(song)))
}

/**
 * Internal HTTP API layer for the live client (not part of the public API).
 *
 * All REST endpoints of the MusicParty server are unauthenticated at the HTTP layer
 * except for the optional v2 room token (`X-Room-Token`, S-07). The room password is
 * checked on the STOMP CONNECT frame; the documented pre-flight
 * (`/api/auth/status` → `/api/auth/verify`) is implemented here and tolerates the
 * SPA's HTML fallback for unknown routes.
 *
 * Every request resolves against the **current session base** (`session.js`), so a
 * server switch cannot split HTTP from the WebSocket (D-16); unjoined callers fall
 * back to the saved address.
 *
 * @module core/live/api
 */

import axios from 'axios'
import { live } from './state.js'
import { loadSettings } from './config.js'
import {
  activeBase,
  applyConfigMeta,
  clearRoomToken,
  hasRoomToken,
  setRoomToken,
  session
} from './session.js'
import { toSong, toLyricLines, normalizePlatform } from './mapping.js'

/** API path prefixes protected by the optional REST room token (S-07). */
const ROOM_TOKEN_PATHS = ['/api/search/', '/api/music/', '/api/playlist/', '/api/user/']

// A password is scoped to one frozen session and is never written to storage.
let roomAccess = null
let resourceProtocol = null
export function clearRoomAccess() { roomAccess = null; resourceProtocol = null }

/** localStorage marker used by older builds (kept for diagnostics only). */
const LEGACY_TOKEN_KEY = 'mp.desktop.token'

/**
 * Electron main-process HTTP bridge (bypasses the renderer CORS restriction).
 * @returns {{ request: (options: Object) => Promise<Object> } | null}
 */
function httpBridge() {
  try {
    if (typeof window !== 'undefined' && window.mpDesktop?.http?.request) {
      return window.mpDesktop.http
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Does this path accept/require the REST room token?
 * @param {string} path
 * @returns {boolean}
 */
function pathNeedsRoomToken(path) {
  return ROOM_TOKEN_PATHS.some((prefix) => path.startsWith(prefix))
}

/**
 * Parse a bridge response body into the same shape axios would return.
 * @param {string} bodyText
 * @param {string} contentType
 * @returns {any}
 */
function parseBody(bodyText, contentType) {
  if (!bodyText) return ''
  if (String(contentType).includes('json') || /^\s*[[{]/.test(bodyText)) {
    try {
      return JSON.parse(bodyText)
    } catch {
      return bodyText
    }
  }
  return bodyText
}

/**
 * Axios request against the current session base. HTTP error statuses are returned to
 * the caller (not thrown) so the auth flow can inspect 401/429 bodies.
 * Inside Electron the request is forwarded through the preload IPC bridge, because the
 * backend does not send CORS headers. Redirects are refused there so a 30x cannot
 * carry the room token / credentials to another origin.
 * @param {'get' | 'post'} method
 * @param {string} path
 * @param {any} [data]
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function request(method, path, data) {
  const generation = session.generation
  const url = `${activeBase()}${path}`
  const headers = {
    Accept: 'application/json',
    ...(data !== undefined ? { 'Content-Type': 'application/json' } : {})
  }
  if (path.startsWith('/api/v2/') && roomAccess?.generation === session.generation) {
    headers['X-Room-Password'] = roomAccess.password
  }
  if (hasRoomToken() && pathNeedsRoomToken(path)) headers['X-Room-Token'] = session.roomToken
  const bridge = httpBridge()
  if (bridge) {
    const response = await bridge.request({
      url,
      method: method.toUpperCase(),
      headers,
      body: data !== undefined ? JSON.stringify(data) : undefined,
      timeout: 10000,
      redirect: 'error',
      followRedirects: false
    })
    if (response?.redirected || (Number(response?.status) >= 300 && Number(response?.status) < 400)) {
      throw new Error('服务器返回了重定向（已拒绝跟随）')
    }
    if (response.error) {
      throw new Error(response.error)
    }
    if (generation !== session.generation) throw new Error('房间会话已改变，请重试')
    if (Number(response.status) === 401) clearRoomToken()
    return {
      status: response.status,
      data: parseBody(response.bodyText, response.contentType),
      headers: {}
    }
  }
  const response = await axios({
    method,
    url,
    data,
    timeout: 8000,
    maxRedirects: 0,
    validateStatus: () => true,
    headers
  })
  if (generation !== session.generation) throw new Error('房间会话已改变，请重试')
  if (Number(response.status) >= 300 && Number(response.status) < 400) throw new Error('服务器返回了重定向（已拒绝跟随）')
  if (Number(response.status) === 401) clearRoomToken()
  return response
}

/**
 * Perform a request and return its parsed body. Rejects the SPA HTML fallback and HTTP
 * errors (business errors are 502 with `{ message }` on this server).
 * @param {'get' | 'post'} method
 * @param {string} path
 * @param {any} [data]
 * @returns {Promise<any>}
 */
async function requestJson(method, path, data) {
  const response = await request(method, path, data)
  if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
    throw new Error('服务器返回了 HTML（该地址可能不是 MusicParty 后端）')
  }
  if (response.status >= 400) {
    const payload = response.data
    const message = payload && typeof payload === 'object' ? payload.message : ''
    const error = new Error(message || `请求失败（HTTP ${response.status}）`)
    error.status = response.status
    throw error
  }
  return response.data
}

// Probe once per session. Only an absent endpoint (including the old SPA fallback)
// selects legacy routes; authorization and network errors must remain visible.
export async function usesResourceApi() {
  const generation = session.generation
  if (resourceProtocol?.generation === generation) return resourceProtocol.v2
  const response = await request('get', '/api/v2/sources')
  const html = typeof response.data === 'string' && response.data.trim().startsWith('<')
  if (response.status === 404 || (response.status === 200 && html)) {
    if (generation === session.generation) resourceProtocol = { generation, v2: false }
    return false
  }
  if (response.status !== 200 || !Array.isArray(response.data?.sources) || response.data.schemaVersion !== 2) {
    throw new Error(response.data?.message || `音源目录请求失败（HTTP ${response.status}）`)
  }
  if (generation === session.generation) resourceProtocol = { generation, v2: true }
  return true
}

/** Refresh the current playback without altering the room's shared progress. */
export async function refreshPlaybackMedia(playbackId) {
  if (!playbackId || typeof playbackId !== 'string') throw new Error('播放实例无效')
  return requestJson('post', `/api/v2/playbacks/${encodeURIComponent(playbackId)}/media/refresh`)
}

/**
 * HTTP pre-flight: `GET /api/auth/status` then `POST /api/auth/verify` when the room is
 * protected. When REST is unreachable (Electron renderer CORS, wrong address) the check
 * is skipped, because the STOMP CONNECT frame is the authoritative password gate.
 *
 * On success a v2 `roomToken` (if returned) is kept in session memory and attached to
 * the protected REST paths. A 401 clears it and asks the caller to re-verify (S-07).
 *
 * @param {string} password
 * @returns {Promise<{ ok: boolean, error?: string, skipped?: boolean }>}
 */
export async function verifyRoomAccess(password) {
  roomAccess = { generation: session.generation, password: String(password ?? '') }
  resourceProtocol = null
  let status
  try {
    status = await requestJson('get', '/api/auth/status')
  } catch (error) {
    console.warn('[live] HTTP auth status unavailable, relying on STOMP CONNECT:', error?.message)
    return { ok: true, skipped: true }
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) return { ok: true, skipped: true }
  if (!status.hasProtection) return { ok: true }
  if (!password) return { ok: false, error: '该房间已启用密码保护，请输入房间密码' }
  try {
    const response = await request('post', '/api/auth/verify', { password })
    const data = typeof response.data === 'object' && response.data ? response.data : {}
    if (response.status === 429) return { ok: false, error: data.message || '尝试次数过多，请稍后再试' }
    if (response.status === 401) {
      clearRoomToken()
      return { ok: false, error: data.message || '房间密码错误' }
    }
    if (response.status === 200 && data.valid) {
      if (typeof data.roomToken === 'string' && data.roomToken.trim()) setRoomToken(data.roomToken)
      return { ok: true }
    }
    return { ok: false, error: response.status === 401 ? '房间密码错误' : `房间密码验证失败（HTTP ${response.status}）` }
  } catch (error) {
    console.warn('[live] HTTP verify unavailable, relying on STOMP CONNECT:', error?.message)
    return { ok: true, skipped: true }
  }
}

/**
 * Fetch `GET /api/config` and apply protocol-v2 capability discovery.
 *
 * Tolerates the old server shape (`{backWords, authorName}`): missing capability fields
 * simply mean "no v2 features", and the client degrades to the legacy behaviour.
 *
 * @param {{ deriveRoomName?: boolean }} [options]
 * @returns {Promise<{ capabilities: string[], adminConfigured: boolean | null, body: any } | null>}
 */
export async function fetchConfigMeta(options = {}) {
  let body = null
  try {
    const started = Date.now()
    body = await requestJson('get', '/api/config')
    if (body && typeof body === 'object' && !Array.isArray(body)) applyConfigMeta(body)
    if (!live.latency) live.latency = Math.max(1, Date.now() - started)
  } catch (error) {
    console.warn('[live] /api/config unavailable:', error?.message)
  }
  if (options.deriveRoomName !== false) live.roomName = `${live.server} 房间`
  return {
    capabilities: [...session.capabilities],
    adminConfigured: session.adminConfigured,
    body
  }
}

/**
 * Low-frequency HTTP fallback for the latency indicator on servers without the `ping`
 * capability (D-06). Measures the round trip of `GET /api/config`; never broadcasts.
 *
 * @returns {Promise<number>} RTT in ms (`0` when unavailable).
 */
export async function probeHttpLatency() {
  if (!activeBase()) return 0
  try {
    const started = Date.now()
    await requestJson('get', '/api/config')
    const rtt = Math.max(1, Math.min(9999, Date.now() - started))
    live.latency = rtt
    return rtt
  } catch (error) {
    console.warn('[live] HTTP latency probe failed:', error?.message)
    return 0
  }
}

/**
 * Search a platform: `GET /api/search/{platform}/{keyword}` → `Music[]`.
 * No pagination parameters exist; Bilibili returns at most 20 page-1 results.
 * `INVALID_SKIP` ("已失效视频") rows are filtered out.
 *
 * @param {'netease' | 'bilibili'} platform
 * @param {string} keyword
 * @returns {Promise<import('./state.js').LiveSong[]>}
 * @throws {Error} on HTTP/network failure or an HTML response.
 */
export async function searchPlatform(platform, keyword) {
  const source = normalizePlatform(platform)
  const term = String(keyword ?? '').trim()
  if (!term) return []
  const v2 = await usesResourceApi()
  const data = await requestJson('get', v2 ? `/api/v2/sources/${encodeURIComponent(source)}/tracks/search?q=${encodeURIComponent(term)}` : `/api/search/${source}/${encodeURIComponent(term)}`)
  const rows = v2 ? data?.items : data
  if (!Array.isArray(rows)) return []
  return rows.filter((row) => row && row.id && row.id !== 'INVALID_SKIP').map((row) => toSong(row))
}

export async function getSongAlbum(platform, musicId) {
  if (!await usesResourceApi()) throw new Error('此房间暂不支持专辑')
  const source = normalizePlatform(platform)
  const id = String(musicId ?? '').trim()
  if (!id) throw new Error('歌曲标识无效')
  const album = await requestJson('get', `/api/v2/sources/${encodeURIComponent(source)}/tracks/${encodeURIComponent(id)}/album`)
  if (!album || !album.id || album.collectionType !== 'album') throw new Error('专辑数据格式无效')
  return album
}

/** These read-only requests use the current room token; the account binding stays local. */
export async function searchUsers(platform, keyword) {
  const term = String(keyword ?? '').trim()
  if (!term) return []
  const source = normalizePlatform(platform)
  const v2 = await usesResourceApi()
  const data = await requestJson('get', v2 ? `/api/v2/sources/${encodeURIComponent(source)}/users/search?q=${encodeURIComponent(term)}` : `/api/user/search/${source}/${encodeURIComponent(term)}`)
  const rows = v2 ? data?.items : data
  return Array.isArray(rows) ? rows.filter(row => row && row.id != null).map(row => ({
    id: String(row.id), name: String(row.name || row.id), avatarUrl: String(row.avatarUrl || '')
  })) : []
}

export async function getUserPlaylists(platform, userId) {
  const id = String(userId ?? '').trim()
  if (!id) return []
  const source = normalizePlatform(platform)
  const v2 = await usesResourceApi()
  if (v2) {
    const categories = await requestJson('get', `/api/v2/sources/${encodeURIComponent(source)}/collection-categories`)
    const category = Array.isArray(categories) && categories.find(item => item.entryKind === 'CONTAINER')
    if (!category) return []
    const rows = []
    let cursor = null
    let pageCount = 0
    do {
      if (++pageCount > 100) throw new Error('收藏分页数量过多，请缩小范围')
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const page = await requestJson('get', `/api/v2/sources/${encodeURIComponent(source)}/collections/${encodeURIComponent(category.id)}?userId=${encodeURIComponent(id)}&limit=50${suffix}`)
      if (!Array.isArray(page?.items)) throw new Error('收藏数据格式无效')
      rows.push(...page.items)
      const next = page.nextCursor || null
      if (next && next === cursor) throw new Error('收藏分页未前进')
      cursor = next
      if (rows.length > 5000) throw new Error('收藏数量过多，请缩小范围')
    } while (cursor)
    return rows.filter(row => row && row.id != null).map(row => ({ id: String(row.id), name: String(row.name || row.id), coverImgUrl: String(row.coverUrl || ''), trackCount: Math.max(0, Number(row.trackCount) || 0), collectionType: row.collectionType || category.collectionType }))
  }
  const rows = await requestJson('get', `/api/user/playlists/${source}/${encodeURIComponent(id)}`)
  return Array.isArray(rows) ? rows.filter(row => row && row.id != null).map(row => ({
    id: String(row.id), name: String(row.name || row.id), coverImgUrl: String(row.coverImgUrl || ''),
    trackCount: Math.max(0, Number(row.trackCount) || 0)
  })) : []
}

export async function getPlaylistSongs(platform, playlistId, offset = 0, limit = 50, collectionType = '') {
  const source = normalizePlatform(platform)
  const id = String(playlistId ?? '').trim()
  if (!id) return { songs: [], rawCount: 0 }
  const pageSize = source === 'bilibili' ? 20 : 50
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
  const safeLimit = Math.max(1, Math.min(pageSize, Math.floor(Number(limit) || pageSize)))
  if (await usesResourceApi()) {
    const type = collectionType || (source === 'bilibili' ? 'favorites' : 'playlist')
    const suffix = offset ? `&cursor=${encodeURIComponent(offset)}` : ''
    const page = await requestJson('get', `/api/v2/sources/${encodeURIComponent(source)}/containers/${encodeURIComponent(type)}/${encodeURIComponent(id)}/tracks?limit=${safeLimit}${suffix}`)
    if (!Array.isArray(page?.items)) throw new Error('歌单数据格式无效')
    return { songs: page.items.filter(row => row && row.id && row.id !== 'INVALID_SKIP').map(row => toSong(row)), rawCount: page.items.length, nextCursor: page.nextCursor || null }
  }
  const rows = await requestJson('get', `/api/playlist/songs/${source}/${encodeURIComponent(id)}?offset=${safeOffset}&limit=${safeLimit}`)
  const list = Array.isArray(rows) ? rows : []
  return { songs: list.filter(row => row && row.id && row.id !== 'INVALID_SKIP').map(row => toSong(row)), rawCount: list.length, nextCursor: list.length >= safeLimit ? safeOffset + list.length : null }
}

/* ------------------------------------------------------------------ */
/* Lyrics with request ordering + current-song ownership (D-13)        */
/* ------------------------------------------------------------------ */

/** Monotonic request counter: only the newest lyric request may touch live state. */
let lyricRequestSeq = 0

/** Identity of the song a lyric request belongs to. */
function lyricSongKey(platform, musicId) {
  return `${normalizePlatform(platform)}:${String(musicId)}`
}

/**
 * Is the resolved lyric still allowed to be displayed?
 *
 * @param {number} seq Request sequence captured when the request started.
 * @param {number} generation Session generation captured when the request started.
 * @param {string} platform Normalized platform of the requested song.
 * @param {string} musicId Music id of the requested song.
 * @returns {boolean}
 */
function isCurrentLyricRequest(seq, generation, platform, musicId) {
  if (seq !== lyricRequestSeq) return false
  if (generation !== session.generation) return false
  const current = live.nowPlaying
  if (!current) return false
  return String(current.id) === String(musicId) && normalizePlatform(current.source) === normalizePlatform(platform)
}

/**
 * Invalidate every in-flight lyric request and clear the displayed lyrics.
 * Called when the room is left or the current song disappears.
 * @returns {void}
 */
export function invalidateLyrics() {
  lyricRequestSeq += 1
  live.lyrics = []
}

/**
 * Fetch lyrics: `GET /api/music/lyric/{platform}/{musicId}` returns a JSON string of LRC
 * text. Bilibili has no lyrics support (always `""`). Results are stored in `live.lyrics`
 * only when the request still belongs to the current song/session.
 *
 * Race safety (D-13):
 * - requests are sequenced; a slow older response can never overwrite a newer one;
 * - results are validated against `live.nowPlaying` (id + platform) and the session
 *   generation, so leaving the room / switching songs drops in-flight responses;
 * - a stale failure never clears the lyrics of the current song.
 *
 * @param {string | import('./state.js').LiveSong | { platform?: string, source?: string, id?: string, musicId?: string }} song
 * @param {{ request?: (method: 'get', path: string) => Promise<any> }} [deps]
 *   Test seam: inject a fake request implementation.
 * @returns {Promise<{ t: number, text: string, trans?: string }[]>} lines in seconds.
 */
export async function fetchLyrics(song, deps = {}) {
  const platform = normalizePlatform(song?.source || song?.platform)
  const musicId = String(song?.musicId || song?.id || '')
  if (!musicId) return []
  const requestFn = typeof deps.request === 'function' ? deps.request : requestJson
  const seq = ++lyricRequestSeq
  const generation = session.generation
  // Clear stale lyrics immediately when this request is for the currently playing song.
  if (isCurrentLyricRequest(seq, generation, platform, musicId)) live.lyrics = []
  try {
    const v2 = deps.request ? false : await usesResourceApi()
    const data = await requestFn('get', v2 ? `/api/v2/sources/${encodeURIComponent(platform)}/tracks/${encodeURIComponent(musicId)}/lyrics` : `/api/music/lyric/${platform}/${encodeURIComponent(musicId)}`)
    if (!isCurrentLyricRequest(seq, generation, platform, musicId)) return live.lyrics
    const lines = toLyricLines(typeof data === 'string' ? data : '')
    if (!isCurrentLyricRequest(seq, generation, platform, musicId)) return live.lyrics
    live.lyrics = lines
    return lines
  } catch (error) {
    if (isCurrentLyricRequest(seq, generation, platform, musicId)) live.lyrics = []
    console.warn('[live] lyric fetch failed:', error?.message)
    return live.lyrics
  }
}

/**
 * Debug/testing helper for the lyric race tests.
 * @returns {number}
 */
export function lyricRequestSequence() {
  return lyricRequestSeq
}

/**
 * Legacy identity key expected by older builds (exposed for migration tooling).
 * @returns {string}
 */
export function legacyTokenStorageKey() {
  return LEGACY_TOKEN_KEY
}

/**
 * Load persisted settings (re-exported for convenience of callers inside live/*).
 * @returns {{ serverUrl: string, mode: string, userName: string }}
 */
export function configuredSettings() {
  return loadSettings()
}

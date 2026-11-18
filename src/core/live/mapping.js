/**
 * Mapping layer: converts MusicParty server payloads into the UI-facing shapes
 * used by the desktop client (see `state.js` for the target typedefs).
 *
 * Server facts that drive this file:
 * - `dto/Music` uses `name` (not `title`), `artists: string[]`, `duration` in **ms**.
 * - `dto/MusicQueueItem` wraps `{ queueId, music, enqueuedBy, status, priority }`.
 * - `dto/NowPlayingInfo` is `{ music, currentPosition(ms), enqueuedById, enqueuedByName,
 *   likedUserIds: string[], likeMarkers: number[] }`.
 * - `dto/UserSummary` is `{ token, sessionId, name, isGuest }`.
 * - `dto/ChatMessage` is `{ id, userId, userName, content, timestamp(ms), type }`.
 * - There is no album, no enqueue timestamp, no history and no queue-like counter in the
 *   protocol; those UI fields are therefore `null`/`0` and must be handled by the UI.
 *
 * @module core/live/mapping
 */

import dayjs from 'dayjs'

/** @typedef {import('./state.js').LiveSong} LiveSong */

/** @type {Record<string, { label: string, tag: string, quality: string }>} */
const PLATFORM_META = {
  netease: { label: '网易云', tag: 'NETEASE', quality: '极高 · 320k' },
  bilibili: { label: 'B站', tag: 'BILIBILI', quality: '视频音轨' },
  qqmusic: { label: 'QQ音乐', tag: 'QQMUSIC', quality: '音源' }
}

/** Deterministic cover palettes (bg / fg pairs). */
const COVER_PALETTES = [
  { bg: '#141314', fg: '#ffcd38' },
  { bg: '#f6c42a', fg: '#141414' },
  { bg: '#fcfcfd', fg: '#141414' },
  { bg: '#e0ae00', fg: '#141414' },
  { bg: '#141314', fg: '#fcfcfd' },
  { bg: '#ffcd38', fg: '#141414' }
]

/** Uppercase English captions for CJK-only titles. */
const COVER_SUBS = [
  'NIGHT SIGNAL',
  'LATE NIGHT',
  'ROOM TONE',
  'BLUE HOUR',
  'WARM STATIC',
  'OPEN CHANNEL'
]

/**
 * Image hosts that are known to serve their covers over HTTPS. Only these are
 * upgraded from plain `http://` to `https://`; arbitrary `http://` hosts (for
 * example a self-hosted server on the LAN) are left untouched so the image does
 * not turn into a 404 after the scheme swap.
 *
 * The Java backend (`NeteaseMusicApiService.upgradeToHttps`,
 * `BilibiliApiUtils.normalizeCoverUrl`) already normalizes most of these, but
 * older production servers can still emit `http://` or protocol-relative
 * (`//host/...`) URLs, so the client normalizes defensively.
 */
const HTTPS_COVER_HOSTS = [
  /(^|\.)music\.126\.net$/i, // 网易云音乐图片 CDN: p1/p2/p3/p4.music.126.net
  /(^|\.)126\.net$/i, // 网易云音乐其它图片域名
  /(^|\.)hdslb\.com$/i, // Bilibili 图片 CDN: i0/i1/i2.hdslb.com
  /(^|\.)biliimg\.com$/i,
  /(^|\.)bilivideo\.com$/i,
  /(^|\.)doubanio\.com$/i
]

/**
 * Normalize a server-provided cover URL for `<img>` usage.
 *
 * Accepts an empty/missing value (`null`), protocol-relative URLs (upgraded to
 * HTTPS) and absolute `http(s)` URLs. Plain HTTP on a known image CDN is
 * upgraded to HTTPS to avoid mixed content; other HTTP hosts keep their scheme
 * (the renderer retries the HTTPS variant if the image fails to load).
 *
 * Anything that is not an `http(s)`/`//` URL (e.g. `data:` or `javascript:`) is
 * rejected — the cover is server-controlled data and must never become a code
 * injection vector.
 *
 * @param {unknown} raw `coverUrl` from `Music` / `PlayableMusic`.
 * @returns {string | null} Safe absolute URL, or `null` when unusable.
 */
export function normalizeCoverUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null
  let url = value
  if (url.startsWith('//')) url = `https:${url}`
  if (!/^https?:\/\//i.test(url)) return null
  if (/^http:\/\//i.test(url)) {
    try {
      const host = new URL(url).hostname
      if (HTTPS_COVER_HOSTS.some((pattern) => pattern.test(host))) {
        url = `https://${url.slice('http://'.length)}`
      }
    } catch {
      return null
    }
  }
  return url
}

/**
 * Cheap deterministic string hash (djb2, unsigned 32-bit).
 * @param {string} input
 * @returns {number}
 */
function hashString(input) {
  let hash = 5381
  for (const ch of String(input ?? '')) {
    hash = ((hash * 33) ^ (ch.codePointAt(0) || 0)) >>> 0
  }
  return hash
}

/**
 * Normalize a server platform string to the two UI source ids.
 * `netease-fm` (private FM placeholder) maps to `netease`.
 * @param {string} [platform]
 * @returns {'netease' | 'bilibili'}
 */
export function normalizePlatform(platform) {
  const value = String(platform ?? '').trim().toLowerCase()
  if (!value || value === 'netease-fm' || value.includes('网易')) return 'netease'
  if (value === 'bilibili' || value === 'bili' || value === 'b站') return 'bilibili'
  return value
}

/**
 * Extended info for a platform (UI raw material).
 * @param {string} [platform]
 * @returns {{ label: string, tag: string, quality: string }}
 */
export function platformMeta(platform) {
  const id = normalizePlatform(platform)
  return PLATFORM_META[id] || { label: id, tag: id.toUpperCase(), quality: '音源' }
}

/**
 * Deterministic typographic cover derived from the song title.
 *
 * This is the **fallback** cover rendered when the server provides no usable
 * image URL (or the image fails to load). `toSong()` decorates the returned
 * object with a normalized `url` field when `Music.coverUrl` is available; the
 * desktop UI renders that URL as a real album image and keeps this CSS cover
 * underneath as the error/no-data fallback.
 *
 * The palette / caption are stable for a given title so re-renders never flicker.
 *
 * @param {string} title Song title.
 * @param {{ source?: string, platform?: string }} [opts] Platform hint for `tag`.
 * @returns {{ bg: string, fg: string, mark: string, sub: string, tag: string }}
 */
export function coverFor(title, opts = {}) {
  const name = String(title ?? '').trim() || '未知曲目'
  const meta = platformMeta(opts.source ?? opts.platform)
  const palette = COVER_PALETTES[hashString(name) % COVER_PALETTES.length]
  const latin = name.match(/[A-Za-z][A-Za-z0-9'’.\- ]*/)?.[0]?.trim()
  const sub = latin
    ? latin.toUpperCase().slice(0, 18)
    : COVER_SUBS[hashString(`sub:${name}`) % COVER_SUBS.length]
  return {
    bg: palette.bg,
    fg: palette.fg,
    mark: [...name].slice(0, 3).join(''),
    sub,
    tag: meta.tag
  }
}

/**
 * Convert a server millisecond duration to whole seconds.
 * @param {unknown} value
 * @returns {number}
 */
function toSeconds(value) {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0
}

/**
 * Public identity id of a raw user/chat/member payload.
 *
 * Protocol v2 broadcasts only the **public id** (`id`); old servers broadcast
 * `token`. Both are accepted so the client works against either server.
 *
 * @param {any} raw `UserSummary` / `ChatMessage` / `likedUserIds` entry.
 * @returns {string}
 */
export function publicIdOf(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw)
  return String(raw.id ?? raw.publicId ?? raw.token ?? '')
}

/**
 * Join the server `artists` array (or fall back to a single artist string).
 * @param {any} music
 * @param {string} [fallback]
 * @returns {string}
 */
function artistOf(music, fallback = '未知歌手') {
  if (Array.isArray(music?.artists)) {
    const artists = music.artists.filter(Boolean).map(String)
    if (artists.length) return artists.join(' / ')
  }
  if (typeof music?.artist === 'string' && music.artist.trim()) return music.artist.trim()
  return fallback
}

/**
 * Ensure a song-like object carries the display fields the UI components require.
 *
 * `toSong()` always produces a deterministic `cover` object, but the live queue can
 * also be populated from other sources (tests/harnesses injecting raw fixture objects,
 * future/older producers, malformed server payloads). `TrackCover` requires a cover
 * object and several views assume basic song fields exist, so a missing cover would
 * throw during render and abort the patch (D-01 runtime harness found this: the queue
 * render error left the inspector stuck on the room inspector).
 *
 * Returns the original object when it is already display-ready (keeps proxies /
 * identity stable), otherwise a shallow copy with a deterministic fallback cover.
 *
 * @param {any} song
 * @returns {any}
 */
export function ensureSongDisplayFields(song) {
  if (!song || typeof song !== 'object') return song
  if (song.cover && typeof song.cover === 'object') return song
  return { ...song, cover: coverFor(song.title, { source: song.source || song.platform }) }
}

/**
 * Map a server `Music`, `PlayableMusic` or `MusicQueueItem` into the UI song shape.
 *
 * @param {any} raw `Music` / `PlayableMusic` / `MusicQueueItem` payload.
 * @param {Object} [opts]
 * @param {'playing' | 'paused' | 'queued'} [opts.state] Overrides the derived state.
 * @param {number} [opts.progress] Seconds (now playing only).
 * @param {string | null} [opts.requestedBy] Enqueuer display name.
 * @param {number} [opts.liked] Like count.
 * @param {boolean} [opts.likedByMe] Whether the local user liked the track.
 * @param {boolean} [opts.pinned] Override the derived pin flag.
 * @param {string | null} [opts.addedAt] UI clock label (never provided by the server).
 * @param {string | null} [opts.playedAt] UI clock label (never provided by the server).
 * @param {string | null} [opts.album] Album label (never provided by the server).
 * @param {string} [opts.quality] Presentation-only quality label.
 * @param {string | null} [opts.queueId] Explicit queue id override.
 * @returns {LiveSong}
 */
export function toSong(raw, opts = {}) {
  const item = raw && raw.music ? raw : null
  const music = item ? item.music : raw || {}
  const platform = normalizePlatform(music.platform ?? opts.source)
  const meta = platformMeta(platform)
  const title = String(music.name ?? music.title ?? opts.title ?? '').trim() || '未知曲目'
  const status = String(item?.status ?? '').toUpperCase()
  const priority = String(item?.priority ?? '').toUpperCase()
  const state = opts.state || (status === 'PLAYING' ? 'playing' : 'queued')
  const queueId = item?.queueId ?? opts.queueId ?? null
  // Real album art (backend `Music.coverUrl` / `PlayableMusic.coverUrl`), if the
  // server provides one. `null` keeps the deterministic typographic fallback.
  const coverUrl = normalizeCoverUrl(music.coverUrl)
  // S-01/协议 v2：PlayableMusic 可能只提供试听片段。`playableDurationMs` 是实际
  // 可播时长（完整曲目=歌曲时长，试听=上游返回的片段时长），进度锚定与 UI 时长
  // 必须以它为准，不能再用整曲 duration 假装能播完整首。
  const fullDuration = toSeconds(music.fullDurationMs ?? music.duration)
  const playableMs = Number(music.playableDurationMs)
  const playableDuration =
    Number.isFinite(playableMs) && playableMs > 0 ? Math.round(playableMs / 1000) : fullDuration
  const urlTypeRaw = typeof music.urlType === 'string' ? music.urlType.trim().toUpperCase() : ''
  const trial = Boolean(music.trial) || urlTypeRaw === 'TRIAL'
  const qualityBase = opts.quality || meta.quality

  /** @type {LiveSong} */
  const song = {
    id: String(music.id ?? opts.id ?? ''),
    queueId: queueId == null ? null : String(queueId),
    ownerId: publicIdOf(item?.enqueuedBy),
    ownerGuest: Boolean(item?.enqueuedBy?.isGuest),
    priority: priority || null,
    title,
    artist: artistOf(music),
    album: opts.album ?? null,
    source: platform,
    kind: typeof music.kind === 'string' ? music.kind : null,
    sourceLabel: meta.label,
    duration: playableDuration,
    playableDuration,
    fullDuration,
    trial,
    trialDurationKnown: !trial || (Number.isFinite(playableMs) && playableMs > 0),
    urlType: urlTypeRaw || null,
    quality: trial ? `${qualityBase} · 试听` : qualityBase,
    requestedBy: opts.requestedBy ?? item?.enqueuedBy?.name ?? null,
    liked: Math.max(0, Number(opts.liked) || 0),
    likedByMe: Boolean(opts.likedByMe),
    pinned: opts.pinned != null ? Boolean(opts.pinned) : priority === 'GLOBAL_TOP' || priority === 'USER_TOP',
    state,
    addedAt: opts.addedAt ?? null,
    playedAt: opts.playedAt ?? null,
    url: typeof music.url === 'string' && music.url && music.url !== 'null' ? music.url : null,
    externalUrl: typeof music.externalUrl === 'string' ? music.externalUrl : '',
    needsProxy: Boolean(music.needsProxy),
    coverUrl,
    cover: { ...coverFor(title, { source: platform }), url: coverUrl }
  }

  if (opts.progress != null) song.progress = Math.max(0, Number(opts.progress) || 0)
  return song
}

/**
 * Map one `MusicQueueItem` (the server already wraps the music) into a song.
 * Queue items have no like data, so `liked` stays `0` and `likedByMe` stays `false`.
 *
 * @param {any} raw `MusicQueueItem` payload.
 * @param {Object} [opts] Forwarded to {@link toSong}.
 * @returns {LiveSong}
 */
export function toQueueItem(raw, opts = {}) {
  return toSong(raw, { ...opts, state: opts.state || 'queued' })
}

/**
 * Map a `UserSummary` into a member row.
 *
 * The server has no roles/status feed: non-guests are `成员`, guests are `游客`,
 * and everyone is reported as `在听`. `you` is derived from the client's public id
 * (`opts.myId`; `opts.myToken` is accepted for backward compatibility with the old
 * token-based server).
 *
 * @param {any} raw `UserSummary` payload.
 * @param {{ myId?: string, myToken?: string, status?: string }} [opts]
 * @returns {{ name: string, role: string, status: string, you: boolean }}
 */
export function toMember(raw, opts = {}) {
  const isGuest = Boolean(raw?.isGuest)
  const myId = String(opts.myId || opts.myToken || '')
  return {
    id: publicIdOf(raw),
    name: String(raw?.name || '游客'),
    role: isGuest ? '游客' : '成员',
    status: opts.status || '在听',
    you: Boolean(myId && publicIdOf(raw) === myId)
  }
}

/**
 * Map a `ChatMessage` (chat / system / like / play-start) into a chat row.
 *
 * `PLAY_START` becomes a `song` card when the caller passes the current now-playing
 * song (the protocol only carries the song *name* in the message text); otherwise it
 * degrades to a system line. `me` compares the message's public user id against
 * `opts.myId` (`opts.myToken` is the legacy fallback).
 *
 * @param {any} raw `ChatMessage` payload.
 * @param {{ myId?: string, myToken?: string, nowPlaying?: LiveSong | null, roleOf?: (id: string) => string | null }} [opts]
 * @returns {import('./state.js').LiveChatMessage}
 */
export function toChatMessage(raw, opts = {}) {
  const type = String(raw?.type || 'CHAT').toUpperCase()
  const content = String(raw?.content ?? '')
  const userId = String(raw?.userId ?? '')
  const userName = String(raw?.userName ?? '')
  const myId = String(opts.myId || opts.myToken || '')
  const message = {
    id: String(raw?.id || `c-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`),
    type: type === 'CHAT' ? 'chat' : 'system',
    time: dayjs(Number(raw?.timestamp) || Date.now()).format('HH:mm'),
    user: userName || '系统',
    role: opts.roleOf ? opts.roleOf(userId) || null : null,
    text: content,
    me: Boolean(myId && userId === myId)
  }

  if (type === 'PLAY_START') {
    // The wire message carries a title, not an ID; never attach a different
    // current track to an older history item merely because a song is playing.
    const match = content.match(/^正在播放来自于\s*(.*?)\s+的\s+(.+)$/)
    const title = match ? match[2].trim() : ''
    const current = opts.nowPlaying
    const matched = current && title && current.title === title
    const song = matched ? { ...current } : title ? {
      id: '', title, artist: '历史记录', cover: coverFor(title)
    } : null
    return { ...message, type: 'song', song }
  }
  if (type === 'CHAT') {
    message.command = /^\//.test(content)
  }
  return message
}

/**
 * Parse an LRC document (or a server-escaped JSON string of one) into lyric lines.
 *
 * The server endpoint returns a JSON **string** containing LRC text; both the parsed
 * string and a raw `"..."` body are accepted. Times are returned in **seconds**
 * (matching `live.progress`) so the UI can compare them directly.
 *
 * @param {string | Array<{ t?: number, time?: number, text?: string, lyric?: string }>} raw
 * @returns {{ t: number, text: string, trans?: string }[]}
 */
export function toLyricLines(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((line) => {
        const t = Number(line?.t ?? Number(line?.time ?? 0) / 1000)
        const text = String(line?.text ?? line?.lyric ?? '').trim()
        return Number.isFinite(t) && text ? { t: Math.round(t * 1000) / 1000, text } : null
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t)
  }

  let text = typeof raw === 'string' ? raw : ''
  if (!text.trim()) return []
  const trimmed = text.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      text = JSON.parse(trimmed)
    } catch {
      /* not a quoted JSON string: keep the original text */
    }
  }

  const tag = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g
  /** @type {Map<number, { t: number, text: string, trans?: string }>} */
  const byTime = new Map()

  for (const line of String(text).split(/\r?\n/)) {
    tag.lastIndex = 0
    const stamps = []
    let match
    while ((match = tag.exec(line)) !== null) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fraction = match[3] ? Number(match[3].padEnd(3, '0')) : 0
      stamps.push(Math.round((minutes * 60 + seconds + fraction / 1000) * 1000) / 1000)
    }
    if (!stamps.length) continue
    const lyric = line.replace(tag, '').trim()
    if (!lyric) continue
    for (const t of stamps) {
      const existing = byTime.get(t)
      if (!existing) byTime.set(t, { t, text: lyric })
      else if (!existing.trans && existing.text !== lyric) existing.trans = lyric
    }
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

/**
 * Normalize `PlayerState.config` (`AppConfigSummary`) into the shape the UI expects.
 * Missing/invalid values fall back to the server's documented defaults.
 *
 * @param {any} raw `PlayerState.config` payload.
 * @returns {Object} Normalized config with nested `privateDj`.
 */
export function toConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const num = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const dj = src.privateDj && typeof src.privateDj === 'object' ? src.privateDj : {}
  const sources = src.sources && typeof src.sources === 'object' ? src.sources : {}
  return {
    maxQueueSize: num(src.maxQueueSize, 1000),
    maxHistorySize: num(src.maxHistorySize, 50),
    maxUserSongs: num(src.maxUserSongs, 100),
    maxPlaylistImportSize: num(src.maxPlaylistImportSize, 100),
    maxChatHistorySize: num(src.maxChatHistorySize, 1000),
    minChatIntervalMs: num(src.minChatIntervalMs, 1000),
    maxChatMessageLength: num(src.maxChatMessageLength, 200),
    neteaseEnabled: bool(sources.netease?.enabled, bool(src.neteaseEnabled, true)),
    bilibiliEnabled: bool(sources.bilibili?.enabled, bool(src.bilibiliEnabled, true)),
    qqmusicEnabled: bool(sources.qqmusic?.enabled, false),
    sources: src.sources && typeof src.sources === 'object' ? sources : null,
    allowSeek: bool(src.allowSeek, false),
    allowPlaylistClaim: bool(src.allowPlaylistClaim, false),
    retainPlaylist: bool(src.retainPlaylist, false),
    bilibiliMaxDurationMinutes: num(src.bilibiliMaxDurationMinutes, 10),
    voteSkipEnabled: bool(src.voteSkipEnabled, false),
    voteSkipThreshold: num(src.voteSkipThreshold, 0.5),
    voteSkipWaitTime: num(src.voteSkipWaitTime, 15),
    neteaseCookieConfigured: bool(src.neteaseCookieConfigured, null),
    privateDj: {
      mode: ['OFF', 'FM', 'DJ'].includes(String(dj.mode)) ? String(dj.mode) : 'OFF',
      fillBlankEnabled: bool(dj.fillBlankEnabled, false),
      joinQueueEnabled: bool(dj.joinQueueEnabled, false),
      custodyEnabled: bool(dj.custodyEnabled, false)
    }
  }
}

/**
 * Format an epoch-ms timestamp as a `HH:mm` clock label.
 * @param {number | string | Date} [value]
 * @returns {string}
 */
export function formatClock(value) {
  return dayjs(value ?? Date.now()).format('HH:mm')
}

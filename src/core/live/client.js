/**
 * Public live-client API for the MusicParty desktop app.
 *
 * The module is a singleton (one room session per renderer) and drives the reactive
 * `live` state exported by `state.js`. Internals — the single STOMP connection, topic
 * handlers, HTTP helpers — live in `transport.js`, `api.js`, `session.js` and
 * `commands.js`.
 *
 * Room addressing (D-02/D-12/D-16): `joinRoom()` validates the requested address,
 * freezes it as the immutable **session base** and then runs
 * `/api/auth/status` → `/api/auth/verify` → STOMP CONNECT against that same base.
 * HTTP / WS / media / admin all resolve through the session base; the saved settings
 * address only affects the *next* join. A failed join clears the session base again.
 *
 * Commands (D-15): every mutating command is `async` and returns a structured
 * `{ ok, confirmed, code, message?, retryAfterMs?, reason? }` result. Guests are
 * rejected locally with `code: 'GUEST'` instead of silently publishing a command the
 * server would drop; when the server supports `command-ack` the result reflects the
 * server's answer, otherwise it is explicitly `confirmed: false` ("已发送（未确认）").
 *
 * @module core/live/client
 */

import { live, resetLive } from './state.js'
import { loadSettings, saveSettings, serverHost, parseServerUrl } from './config.js'
import { beginSession, sessionBase } from './session.js'
import { normalizePlatform } from './mapping.js'
import { planReorder } from './reorder.js'
import {
  verifyRoomAccess,
  fetchConfigMeta,
  searchPlatform,
  usesResourceApi,
  fetchLyrics,
  invalidateLyrics
} from './api.js'
import {
  DEST,
  connectRealtime,
  teardownSession,
  publishCommand,
  renameUser as renameSession,
  togglePauseCommand,
  resolveMusicTarget,
  resolveQueueId,
  cacheSongs,
  requestSnapshot,
  onSessionEnd,
  importContainer,
  claimOwnerPlaylist
} from './transport.js'

/** Local rejection for guests: the server keeps them read-only (D-15). */
const GUEST_BLOCKED_REASON = '请先设置昵称成为成员'
let joinGeneration = 0
let lastRoomControlAt = 0

async function sendRoomControl(send) {
  const now = Date.now()
  if (now - lastRoomControlAt < 1000) return localReject('COOLDOWN', '操作太频繁，请稍后再试')
  lastRoomControlAt = now
  const result = await send()
  if (!result.ok && lastRoomControlAt === now) lastRoomControlAt = 0
  return result
}

/**
 * Names the server refuses to turn into a member (it keeps them as guests).
 * Mirrors the backend's reserved-name check (`guest*` / `游客*`).
 * @param {string} name
 * @returns {boolean}
 */
export function isGuestLikeName(name) {
  const value = String(name ?? '').trim().toLowerCase()
  return !value || value.startsWith('guest') || value.startsWith('游客')
}

/**
 * Build a local structured rejection: disconnected or guest (D-15).
 * @returns {{ ok: false, confirmed: false, code: string, reason: string } | null}
 */
function localCommandBlock() {
  if (!live.connected) {
    return { ok: false, confirmed: false, code: 'OFFLINE', reason: '连接已断开，命令未发送' }
  }
  if (live.identity?.isGuest) {
    return { ok: false, confirmed: false, code: 'GUEST', reason: GUEST_BLOCKED_REASON }
  }
  return null
}

/**
 * `{ ok:false, confirmed:false, code:'INVALID'|'NOOP', reason }` helper.
 * @param {string} code
 * @param {string} reason
 * @returns {{ ok: false, confirmed: false, code: string, reason: string }}
 */
function localReject(code, reason) {
  return { ok: false, confirmed: false, code, reason }
}

/**
 * Join a MusicParty room.
 *
 * Flow: validate + normalize the address → freeze it as the session base → atomic
 * teardown of any previous session → `GET /api/auth/status` → `POST /api/auth/verify`
 * (skipped when REST is unreachable) → STOMP CONNECT with `user-name` /
 * `user-token` / `user-recovery-key` / `room-password` / `client` → subscribe all
 * topics → one explicit `/app/player/resync` snapshot.
 *
 * On success `live.connected === true`, `live.joined === true` and
 * `live.sessionBase` is the frozen base. On failure `live.error` contains a
 * user-presentable reason, the frozen base is cleared and the function resolves `false`.
 * After a network drop `@stomp/stompjs` reconnects with exponential backoff
 * (2s → 4s → … → 30s), replaying subscriptions and keeping old data visible.
 *
 * @param {{ name?: string, password?: string, serverUrl?: string }} [options]
 * @returns {Promise<boolean>} true when the STOMP session is established.
 */
export async function joinRoom(options = {}) {
  const generation = ++joinGeneration
  const currentJoin = () => generation === joinGeneration
  const current = loadSettings()
  const userName = String(options.name ?? current.userName ?? '').trim() || '游客'
  const rawTarget =
    options.serverUrl !== undefined && String(options.serverUrl ?? '').trim()
      ? options.serverUrl
      : current.serverUrl
  // 明确报错，绝不静默回退 localhost（D-02）。
  const parsed = parseServerUrl(rawTarget)
  if (!parsed.ok) {
    live.joining = false
    live.error = `服务器地址无效：${parsed.error}`
    return false
  }
  const base = parsed.url

  // Tear down any previous session completely before touching the new address (D-16).
  await teardownSession()
  if (!currentJoin()) return false
  resetLive()
  beginSession(base)
  lastRoomControlAt = 0

  live.joining = true
  live.server = serverHost(base)
  live.roomName = `${live.server} 房间`
  live.capacity = 0
  live.admin = false

  const password = String(options.password ?? '')
  try {
    const auth = await verifyRoomAccess(password)
    if (!currentJoin()) return false
    if (!auth.ok) {
      const message = auth.error || '房间验证失败'
      // teardown 会清空 live，因此失败原因必须在 teardown 之后再写回。
      await teardownSession()
      if (!currentJoin()) return false
      live.joining = false
      live.error = message
      return false
    }

    await fetchConfigMeta()
    if (!currentJoin()) return false
    const connected = await connectRealtime({ serverUrl: base, name: userName, password })
    if (!currentJoin()) return false
    if (!connected) {
      const message = live.error || '连接失败，请检查服务器地址与房间密码'
      await teardownSession()
      if (!currentJoin()) return false
      live.joining = false
      live.error = message
      return false
    }

    // Persist the address/name only after a successful join (the saved value is the
    // "next connection" address; it never retargets the live session).
    saveSettings({ userName, serverUrl: base })

    // The server registers every new STOMP session as a guest; only `/app/user/rename`
    // turns it into a member (members are the ones allowed to control playback when
    // vote-skip/permissions are enforced server-side). Mirror the web client and adopt
    // the nickname right after connecting.
    if (!isGuestLikeName(userName)) {
      setTimeout(() => {
        if (currentJoin() && live.connected) void renameSession(userName)
      }, 150)
    }
    return true
  } catch (error) {
    if (!currentJoin()) return false
    const message = String(error?.message || error)
    await teardownSession()
    if (!currentJoin()) return false
    live.joining = false
    live.error = message
    return false
  }
}

/**
 * Set the current user's nickname; on success the server marks the session as a member
 * (isGuest=false) and broadcasts the updated user list.
 *
 * @param {string} name
 * @returns {Promise<import('./commands.js').CommandResult>} structured result.
 */
export async function rename(name) {
  const value = String(name ?? '').trim()
  if (!value) return localReject('INVALID', '昵称不能为空')
  if (isGuestLikeName(value)) return localReject('INVALID', '不能使用「游客」或以 guest 开头的昵称')
  if (!live.connected) return localReject('OFFLINE', '连接已断开，命令未发送')
  return renameSession(value)
}

/**
 * Leave the room: stop timers, deactivate STOMP, clear the frozen session base, the
 * admin session, in-flight lyrics and all live state.
 *
 * Registered UI lifecycle listeners run afterwards (D-14) — but not for short
 * reconnects.
 *
 * @returns {Promise<void>}
 */
export async function leaveRoom() {
  joinGeneration++
  await teardownSession()
}

/**
 * Register a final session-end callback (D-14). Runs for explicit leave, fatal auth
 * errors, room switches and PASSWORD_CHANGED; not for transient reconnects.
 *
 * @param {(info: { reason: string, error: string }) => void} listener
 * @returns {() => void} unsubscribe
 */
export function setSessionLifecycleListener(listener) {
  return onSessionEnd(listener)
}

/**
 * Invalidate in-flight lyrics and clear the displayed lines (used when the current
 * song disappears before a new lyric request starts).
 * @returns {void}
 */
export function clearLyrics() {
  invalidateLyrics()
}

/**
 * Search a platform over HTTP (`GET /api/search/{platform}/{keyword}`).
 * No pagination is available; Bilibili is capped at 20 upstream results.
 *
 * @param {'netease' | 'bilibili'} platform
 * @param {string} keyword
 * @returns {Promise<import('./state.js').LiveSong[]>} mapped results.
 * @throws {Error} on HTTP/network failure or a non-JSON (HTML) response.
 */
export async function search(platform, keyword) {
  const songs = await searchPlatform(platform, keyword)
  cacheSongs(songs)
  return songs
}

/**
 * Enqueue a song (`SEND /app/enqueue {platform, musicId, requestId}`).
 *
 * Guests are rejected locally with `code:'GUEST'` (the server would silently ignore
 * them); the UI must show "已发送，等待服务器确认" until the queue frame confirms the
 * item instead of claiming success (D-15).
 *
 * @param {string | import('./state.js').LiveSong | { platform?: string, id?: string, musicId?: string }} musicOrId
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function addToQueue(musicOrId) {
  const target = resolveMusicTarget(musicOrId)
  if (!target?.id) return localReject('INVALID', '无法识别的歌曲（缺少音乐 ID）')
  const blocked = localCommandBlock()
  if (blocked) return blocked
  return publishCommand(DEST.enqueue, {
    platform: normalizePlatform(target.platform || 'netease'),
    musicId: target.id
  })
}

/** Import a playlist using the server's queue/quota limits and ACK protocol. */
export async function importPlaylist(platform, playlistId, collectionType = '') {
  const id = String(playlistId ?? '').trim()
  if (!id) return localReject('INVALID', '请选择歌单')
  const blocked = localCommandBlock()
  if (blocked) return blocked
  const source = normalizePlatform(platform)
  if (await usesResourceApi()) {
    return importContainer(source, collectionType || (source === 'bilibili' ? 'favorites' : 'playlist'), id)
  }
  return publishCommand(DEST.enqueuePlaylist, { platform: source, playlistId: id })
}

/**
 * Remove one queue item (`SEND /app/queue/remove {queueId, requestId}`).
 *
 * @param {string | import('./state.js').LiveSong} queueIdOrSong queue id, music id or song.
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function removeFromQueue(queueIdOrSong) {
  const queueId = resolveQueueId(queueIdOrSong)
  if (!queueId) return localReject('INVALID', '队列中找不到这首歌')
  const blocked = localCommandBlock()
  if (blocked) return blocked
  return publishCommand(DEST.queueRemove, { queueId })
}

export async function reorderQueue(next, moved) {
  const blocked = localCommandBlock()
  if (blocked) return blocked
  if (!live.compactSync) return localReject('UNSUPPORTED', '此房间未提供队列排序')
  const request = planReorder(live.queue, next, moved, live.identity?.id, live.playMode)
  if (!request) return localReject('INVALID', '当前模式不能这样排序；普通歌曲按房间权限调整')
  return publishCommand(DEST.reorder, request)
}

export async function claimPlaylist(item) {
  if (!live.connected || !live.compactSync) return localReject('OFFLINE', '当前房间不可认领')
  const owner = String(item?.ownerId || '')
  if (!live.config.allowPlaylistClaim || !owner || item?.ownerGuest || owner === live.identity?.id ||
      ['SYSTEM', 'ADMIN'].includes(owner) || owner.startsWith('__') || live.members.some(member => member.id === owner)) {
    return localReject('INVALID', '该歌单当前不可认领')
  }
  return claimOwnerPlaylist(owner)
}

export async function setPlayMode(mode) {
  const blocked = localCommandBlock()
  if (blocked) return blocked
  if (!live.compactSync || !['SEQUENTIAL', 'SHUFFLE', 'ROUND_ROBIN', 'REPEAT_ONE'].includes(mode)) return localReject('UNSUPPORTED', '此房间不支持该播放模式')
  if (live.playModeLocked) return localReject('LOCKED', '房间播放模式已锁定')
  return sendRoomControl(() => publishCommand(DEST.playMode, { playMode: mode }))
}

export async function seekRoom(seconds, playbackId) {
  const blocked = localCommandBlock()
  if (blocked) return blocked
  if (!live.compactSync || !live.config.allowSeek || live.loading || !live.nowPlaying || !playbackId || playbackId !== live.playbackId) return localReject('UNSUPPORTED', '当前房间不能调整进度')
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0 || value > live.nowPlaying.duration) return localReject('INVALID', '无效的播放进度')
  return sendRoomControl(() => publishCommand(DEST.seek, { positionMs: Math.round(value * 1000), playbackId }))
}

/**
 * Play/pause the room.
 *
 * The desktop used to send the idempotent `/app/control/set-paused` endpoint, which
 * older production servers do not implement (the frame is silently dropped). The
 * legacy `/app/control/toggle-pause` exists on both old and new servers, so we toggle
 * only when the desired state differs from the current authoritative state.
 *
 * @param {boolean} [playing] Desired state; defaults to the inverse of `live.playing`.
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function togglePlay(playing) {
  const desired = typeof playing === 'boolean' ? playing : !live.playing
  if (!live.connected) return localReject('OFFLINE', '连接已断开，命令未发送')
  if (live.identity?.isGuest) return localReject('GUEST', GUEST_BLOCKED_REASON)
  if (desired === live.playing) return localReject('NOOP', '播放状态未变化')
  return sendRoomControl(() => togglePauseCommand())
}

/**
 * Skip to the next track (`SEND /app/control/next {requestId}`). The server decides
 * whether this is an immediate skip or a vote, based on `config.voteSkipEnabled`.
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function skip() {
  const blocked = localCommandBlock()
  if (blocked) return blocked
  return sendRoomControl(() => publishCommand(DEST.next, {}))
}

/**
 * Vote to skip the current track. There is no dedicated vote destination: the server
 * uses the same `/app/control/next` command and counts votes when vote-skip is enabled.
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function voteSkip() {
  return skip()
}

/**
 * Like the currently playing track (`SEND /app/control/like {position, requestId}` in
 * milliseconds). The protocol only supports liking `nowPlaying`; a different id is
 * rejected locally.
 *
 * @param {string | import('./state.js').LiveSong} [musicOrId] must match `live.nowPlaying`.
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function like(musicOrId) {
  if (!live.nowPlaying) return localReject('INVALID', '当前没有正在播放的歌曲')
  const target = musicOrId == null ? null : resolveMusicTarget(musicOrId)
  if (target?.id && target.id !== live.nowPlaying.id) {
    return localReject('INVALID', '只能点赞当前播放的歌曲')
  }
  const blocked = localCommandBlock()
  if (blocked) return blocked
  return publishCommand(DEST.like, { position: Math.round(live.progress * 1000) })
}

/**
 * Pin a queue item (`SEND /app/queue/top {queueId, requestId}`). A second pin upgrades a
 * personal pin to a global pin server-side.
 *
 * @param {string | import('./state.js').LiveSong} musicOrId queue id, music id or song.
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function pin(musicOrId) {
  const queueId = resolveQueueId(musicOrId)
  if (!queueId) return localReject('INVALID', '队列中找不到这首歌')
  const blocked = localCommandBlock()
  if (blocked) return blocked
  return publishCommand(DEST.queueTop, { queueId })
}

/**
 * Send a chat message (`SEND /app/chat {content, requestId}`); `//`-prefixed text runs
 * server commands. Guests are rejected locally (D-15).
 *
 * @param {string} text
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function sendChat(text) {
  const content = String(text ?? '').trim()
  if (!content) return localReject('INVALID', '消息不能为空')
  const maxLength = Number(live.config?.maxChatMessageLength) || 200
  if ([...content].length > maxLength) return localReject('INVALID', `消息超过 ${maxLength} 字上限`)
  const blocked = localCommandBlock()
  if (blocked) return blocked
  return publishCommand(DEST.chatSend, { content })
}

/**
 * Fetch lyrics (`GET /api/music/lyric/{platform}/{musicId}`; the body is a JSON string
 * containing LRC) and store the parsed lines in `live.lyrics`.
 *
 * The request is sequenced and validated against the current song/session (D-13): a
 * stale response never overwrites the lyrics of the currently playing song and a
 * stale failure never clears them.
 *
 * @param {string | import('./state.js').LiveSong | { platform?: string, source?: string, id?: string, musicId?: string }} song
 * @returns {Promise<{ t: number, text: string, trans?: string }[]>} lines in seconds.
 */
export async function getLyrics(song) {
  return fetchLyrics(song)
}

/**
 * Request a fresh authoritative snapshot (`/app/player/resync` broadcasts to the whole
 * room) and resolve with it; falls back to the local state after 2s.
 *
 * Explicit use only (manual "重新同步" / join recovery) — never periodic RTT (D-06).
 *
 * @returns {Promise<Object>} `{ server, sessionBase, capabilities, roomName, roomCode,
 *   online, capacity, locked, playing, progress, config, nowPlaying, queue, members,
 *   lyrics, chat }`
 */
export async function getRoomSnapshot(options) {
  return requestSnapshot(options)
}

/** Current frozen session base (`''` when not joined) — for the UI "copy address". */
export function currentSessionBase() {
  return sessionBase()
}

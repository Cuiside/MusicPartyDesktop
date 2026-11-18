/**
 * Internal transport/session layer for `client.js` (not part of the public API).
 *
 * Owns the single STOMP connection, all topic handlers, the HTTP helpers and the
 * mapping of server frames into the reactive `live` state.
 *
 * The legacy extension protocol is additive:
 * - identity: CONNECT sends both `user-recovery-key` (new) and `user-token` (legacy);
 *   `/user/queue/me` may answer `{id,name,isGuest,recoveryKey}` (v2) or
 *   `{token,name,isGuest}` (old server) — the public id is used for member matching
 *   and the recovery key is stored locally only;
 * - latency: `/app/ping` → `/user/queue/pong` when the server advertises `ping`,
 *   otherwise a low-frequency HTTP `/api/config` RTT; `/app/player/resync` is only
 *   used for explicit full snapshots (D-06);
 * - commands: when `command-ack` is advertised, every command carries a `requestId`
 *   and waits for a point-to-point ACK (D-15, see `commands.js`);
 * - session end: a lifecycle listener notifies the UI on final teardown so audio /
 *   lyrics / anchors are cleaned up consistently (D-14). Short reconnects do NOT fire
 *   it, because `live.reconnecting` keeps playing/buffering intentionally.
 *
 * @module core/live/transport
 */

import { Client, ReconnectionTimeMode } from '@stomp/stompjs'
import { live, resetLive } from './state.js'
import { DEFAULT_SERVER, wsUrl, normalizeServerUrl } from './config.js'
import {
  endSession,
  hasCapability,
  markSessionConnected,
  session,
  sessionBase
} from './session.js'
import { probeHttpLatency, invalidateLyrics, clearRoomAccess } from './api.js'
import { createCommandChannel, defaultRequestId } from './commands.js'
import { createCompactReceiver } from './compact-sync.js'
import { createRoomClock } from './playback-sync.js'
import { adminLogout } from './admin.js'
import { toSong, toQueueItem, toMember, toChatMessage, toConfig, formatClock, publicIdOf } from './mapping.js'
import { shouldNotifyChat } from './chat-notification.js'

/** Legacy identity token (old servers). */
const TOKEN_KEY = 'mp.desktop.token'
/** v2 identity recovery key (secret; localStorage only). */
const RECOVERY_KEY = 'mp.desktop.recovery-key'
const MAX_CHAT = 500
const MAX_ACTIVITY = 60

/** Actual STOMP destinations used (nothing invented). */
export const DEST = {
  state: '/topic/player/state', queue: '/topic/player/queue', users: '/topic/users/online',
  compact: '/topic/player/compact', userCompact: '/user/queue/player/compact',
  appCompact: '/app/player/compact', compactResync: '/app/player/compact-resync',
  reorder: '/app/queue/reorder',
  claim: '/app/queue/claim', userClaim: '/user/queue/playlist/claim',
  playMode: '/app/control/play-mode', seek: '/app/control/seek',
  events: '/topic/player/events', chat: '/topic/chat',
  userEvents: '/user/queue/events', userChatHistory: '/user/queue/chat/history',
  userPrivateChat: '/user/queue/chat/private', userMe: '/user/queue/me',
  userPong: '/user/queue/pong', userCommandAck: '/user/queue/command-ack',
  appMe: '/app/user/me', appChatHistory: '/app/chat/history', resync: '/app/player/resync',
  ping: '/app/ping',
  enqueue: '/app/enqueue', enqueuePlaylist: '/app/enqueue/playlist', enqueueContainer: '/app/enqueue/container', userContainerImport: '/user/queue/container/import', next: '/app/control/next', setPaused: '/app/control/set-paused',
  togglePause: '/app/control/toggle-pause', rename: '/app/user/rename',
  like: '/app/control/like', queueTop: '/app/queue/top', queueRemove: '/app/queue/remove',
  chatSend: '/app/chat'
}

let stomp = null
/** @type {string} legacy `user-token` value (old servers / compatibility header). */
let legacyToken = ''
/** @type {string} v2 recovery key (secret, never displayed). */
let recoveryKey = ''
/** @type {string} public identity id used for member / chat / like matching. */
let myPublicId = ''
let rawMembers = []
let intentionalClose = false
let fatalAuth = false
let lastPlaybackVersion = -1
let anchor = { seconds: 0, atMs: 0, playing: false, duration: 0 }
let ticker = 0
let latencyTimer = 0
let pingRequestId = ''
let pingSentAt = 0
let pendingError = null
let snapshotWaiters = []
const pendingImports = new Map()
const pendingClaims = new Map()
let compactClock = createRoomClock()
const compact = createCompactReceiver({
  apply: state => {
    live.compactSync = true
    compactClock.sample(state)
    applyPlayerState(state)
    if (live.nowPlaying) {
      // The upstream clock distinguishes seeks, repeats and delayed sparse patches.
      const seconds = compactClock.position() / 1000
      anchor = { seconds, atMs: Date.now(), playing: live.playing, duration: live.nowPlaying.duration }
      setProgress(seconds)
    }
  },
  requestSnapshot: () => { if (stomp?.connected) stomp.publish({ destination: DEST.compactResync }) }
})
const searchCache = new Map()

/** @type {Array<(info: { reason: string, error: string }) => void>} */
let sessionEndListeners = []
const likeEventListeners = new Set()
const roomChatListeners = new Set()
export function onRoomChat(listener) {
  if (typeof listener !== 'function') return () => {}
  roomChatListeners.add(listener)
  return () => roomChatListeners.delete(listener)
}
export function onRoomLike(listener) {
  if (typeof listener !== 'function') return () => {}
  likeEventListeners.add(listener)
  return () => likeEventListeners.delete(listener)
}

/**
 * Generate/read a UUID-ish identity value from localStorage (best effort).
 * @param {string} key
 * @returns {string}
 */
function readOrCreateIdentityValue(key) {
  let value = ''
  try {
    if (typeof localStorage !== 'undefined') value = localStorage.getItem(key) || ''
  } catch {
    value = ''
  }
  if (value) return value
  value = defaultRequestId()
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    /* ignore quota/privacy errors */
  }
  return value
}

/**
 * Persist a value under a localStorage key (best effort).
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function persistIdentityValue(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/** Load identity secrets from localStorage (called on module init). */
function loadIdentitySecrets() {
  legacyToken = readOrCreateIdentityValue(TOKEN_KEY)
  recoveryKey = readOrCreateIdentityValue(RECOVERY_KEY)
}

loadIdentitySecrets()

/** @type {ReturnType<typeof createCommandChannel>} */
const commandChannel = createCommandChannel({
  publish: (destination, body) => {
    if (!stomp?.connected) throw new Error('连接已断开')
    stomp.publish({ destination, body: JSON.stringify(body ?? {}) })
  },
  isConnected: () => Boolean(stomp?.connected),
  hasCapability: (name) => hasCapability(name)
})

/** Set progress (seconds) and mirror it on `nowPlaying`. */
function setProgress(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  live.progress = value
  if (live.nowPlaying) live.nowPlaying.progress = value
}

/** Stop the progress ticker. */
function stopTickers() {
  if (ticker) clearInterval(ticker)
  ticker = 0
}

/** Stop the latency probe (ping or HTTP fallback). */
function stopLatencyProbe() {
  if (latencyTimer) clearInterval(latencyTimer)
  latencyTimer = 0
  pingRequestId = ''
  pingSentAt = 0
}

/** Start local progress interpolation. */
function startTickers() {
  stopTickers()
  ticker = setInterval(() => {
    if (!anchor.playing || !live.nowPlaying) return
    let seconds = anchor.seconds + (Date.now() - anchor.atMs) / 1000
    if (anchor.duration > 0) seconds = Math.min(seconds, anchor.duration)
    setProgress(seconds)
  }, 1000)
}

/**
 * One latency measurement.
 *
 * Uses the point-to-point `/app/ping` → `/user/queue/pong` exchange when the server
 * advertises the `ping` capability, otherwise a low-frequency HTTP `/api/config` RTT
 * (never a room-wide broadcast). D-06.
 * @returns {void}
 */
function probeLatency() {
  if (!stomp?.connected) return
  if (hasCapability('ping')) {
    pingRequestId = defaultRequestId()
    pingSentAt = Date.now()
    try {
      stomp.publish({
        destination: DEST.ping,
        body: JSON.stringify({ requestId: pingRequestId, clientTime: pingSentAt })
      })
    } catch {
      pingRequestId = ''
      pingSentAt = 0
    }
    return
  }
  void probeHttpLatency()
}

/** Start the periodic latency probe (30s, low frequency, no broadcast). */
function startLatencyProbe() {
  stopLatencyProbe()
  latencyTimer = setInterval(probeLatency, 30000)
  // First measurement shortly after CONNECTED (not the full 30s wait).
  setTimeout(() => {
    if (stomp?.connected && !live.latency) probeLatency()
  }, 400)
}

/** Handle a `/user/queue/pong` frame: update `live.latency` for the matching request. */
function handlePong(payload) {
  if (!payload || typeof payload !== 'object') return
  const id = String(payload.requestId ?? '')
  if (pingRequestId && id && id !== pingRequestId) return
  const sentAt = Number(payload.clientTime) || pingSentAt
  if (!sentAt) return
  const rtt = Math.max(1, Math.min(9999, Date.now() - sentAt))
  live.latency = rtt
  pingRequestId = ''
  pingSentAt = 0
}

/** Append one activity row, capped. */
function pushActivity(text, time) {
  const value = String(text ?? '').trim()
  if (!value) return
  live.activity.push({ time: time || formatClock(Date.now()), text: value })
  if (live.activity.length > MAX_ACTIVITY) live.activity.splice(0, live.activity.length - MAX_ACTIVITY)
}

/** Apply `onlineUsers` to `live.members`. */
function applyMembers(users) {
  rawMembers = Array.isArray(users) ? users : []
  live.members = rawMembers.map((user) => toMember(user, { myId: myPublicId }))
  live.online = live.members.length
}

/** Apply `MusicQueueItem[]`, dropping the private-FM placeholder. */
function applyQueue(items) {
  if (!Array.isArray(items)) return
  live.queue = items
    .filter((item) => item?.music && item.music.id !== 'netease-fm' && item.music.platform !== 'netease-fm')
    .map((item) => toQueueItem(item))
}

/** Resolve a chat role label from the raw member list (public id aware). */
function roleOfPublicId(publicId) {
  const user = rawMembers.find((member) => publicIdOf(member) === publicId)
  return user ? (user.isGuest ? '游客' : '成员') : null
}

/** Append a chat/system/song message (deduped by server id). */
function pushChat(raw, history = false) {
  if (!raw) return
  const mapped = toChatMessage(raw, { myId: myPublicId, nowPlaying: history ? null : live.nowPlaying, roleOf: roleOfPublicId })
  const existing = live.chat.find((item) => item.id === mapped.id)
  const message = existing || mapped
  if (!existing) live.chat.push(message)
  if (!history) {
    if (live.sessionChat.some((item) => item.id === message.id)) return
    if (!intentionalClose && shouldNotifyChat({ raw, mapped:message, history, existing:Boolean(existing), currentName:live.identity?.name, identityKnown:Boolean(myPublicId && live.identity?.id) })) {
      for (const listener of roomChatListeners) { try { listener({ user: message.user, text: message.text }) } catch (error) { console.warn('[live] chat listener failed', error) } }
    }
    if (message.type === 'song' && message.song && !message.song.id) message.awaitingPlaybackUntil = Date.now() + 5000
    live.sessionChat.push(message)
    if (live.sessionChat.length > MAX_CHAT) live.sessionChat.splice(0, live.sessionChat.length - MAX_CHAT)
  }
  if (live.chat.length > MAX_CHAT) live.chat.splice(0, live.chat.length - MAX_CHAT)
  if (message.type !== 'chat') {
    pushActivity(message.song ? `正在播放《${message.song.title}》` : message.text, message.time)
  }
}

/** Apply a `PlayerState` frame; drops frames older than the last playbackVersion. */
function applyPlayerState(state) {
  if (!state || typeof state !== 'object') return
  const version = Number(state.playbackVersion)
  if (Number.isFinite(version)) {
    if (version < lastPlaybackVersion) return
    lastPlaybackVersion = version
  }
  applyMembers(Array.isArray(state.onlineUsers) ? state.onlineUsers : rawMembers)
  live.config = toConfig(state.config)
  live.playMode = typeof state.playMode === 'string' ? state.playMode : null
  live.playbackId = typeof state.playbackId === 'string' ? state.playbackId : null
  live.loading = Boolean(state.isLoading)
  live.playModeLocked = Boolean(state.isPlayModeLocked)
  live.locked = Boolean(state.isPauseLocked || state.isSkipLocked || state.isPlayModeLocked)

  const info = state.nowPlaying || null
  const music = info?.music || null
  live.playing = Boolean(music) && !state.isPaused
  if (music) {
    const positionMs = Number(info.currentPosition) || 0
    const likedUserIds = Array.isArray(info.likedUserIds) ? info.likedUserIds : []
    live.nowPlaying = toSong(music, {
      state: live.playing ? 'playing' : 'paused',
      progress: positionMs / 1000,
      requestedBy: info.enqueuedByName || null,
      liked: likedUserIds.length,
      likedByMe: Boolean(myPublicId) && likedUserIds.map(publicIdOf).includes(myPublicId),
      pinned: false
    })
    // Anchor against the **playable** duration: trial clips report their real length in
    // playableDurationMs, so the local interpolation never pretends the full track plays.
    anchor = {
      seconds: positionMs / 1000,
      atMs: Date.now(),
      playing: live.playing,
      duration: live.nowPlaying.playableDuration || live.nowPlaying.duration
    }
    setProgress(positionMs / 1000)
    const pending = [...live.sessionChat].reverse().find(row => row.awaitingPlaybackUntil && row.awaitingPlaybackUntil >= Date.now() && row.song?.title === live.nowPlaying.title)
    if (pending) { pending.song = { ...live.nowPlaying }; delete pending.awaitingPlaybackUntil }
  } else {
    live.nowPlaying = null
    anchor = { seconds: 0, atMs: Date.now(), playing: false, duration: 0 }
    live.progress = 0
  }
  if (Array.isArray(state.queue)) applyQueue(state.queue)
  resolveSnapshotWaiters()
}

/** `/topic/player/events` and `/user/queue/events` handler. */
function handleEvent(event) {
  if (!event) return
  if (String(event.action || '').toUpperCase() === 'LIKE') {
    const payload = { message: String(event.message || '有人点了赞').slice(0, 160), song: String(event.payload || '').slice(0, 160) }
    for (const listener of likeEventListeners) { try { listener(payload) } catch (error) { console.warn('[live] like listener failed', error) } }
    return
  }
  if (event.action === 'PASSWORD_CHANGED') return shutdownWithError('房间密码已更改，请重新连接')
  if (event.action === 'RENAME_FAILED') {
    live.renameError = String(event.message || '昵称不可用（可能被占用，或以游客/guest 开头）')
    pushActivity(live.renameError)
    return
  }
  if (String(event.type || '').toUpperCase() === 'ERROR' && event.message) pushActivity(event.message)
}

/**
 * `/app/user/me` + `/user/queue/me` handler.
 *
 * v2 payload: `{ id, name, isGuest, recoveryKey }` — `id` is the public identity used
 * for member matching; `recoveryKey` is stored locally and never displayed/broadcast.
 * Old server payload `{ token, sessionId, name, isGuest }` falls back to `token` as the
 * identity and keeps using the legacy `user-token` header (S-02 / protocol v2).
 */
function handleMe(summary) {
  if (!summary || typeof summary !== 'object') return
  const publicId = String(summary.id ?? summary.publicId ?? summary.token ?? '')
  if (!publicId) return
  const nextRecoveryKey = typeof summary.recoveryKey === 'string' ? summary.recoveryKey.trim() : ''
  live.identity = {
    id: publicId,
    name: String(summary.name ?? ''),
    isGuest: Boolean(summary.isGuest),
    recoveryKey: nextRecoveryKey || recoveryKey
  }
  if (nextRecoveryKey && nextRecoveryKey !== recoveryKey) {
    recoveryKey = nextRecoveryKey
    persistIdentityValue(RECOVERY_KEY, recoveryKey)
  }
  // Old servers only expose `token`; keep the legacy header in sync so a reconnect
  // restores the same identity there.
  const legacy = typeof summary.token === 'string' ? summary.token.trim() : ''
  if (legacy && legacy !== legacyToken) {
    legacyToken = legacy
    persistIdentityValue(TOKEN_KEY, legacyToken)
  }
  if (publicId !== myPublicId) myPublicId = publicId
  if (live.identity.isGuest) {
    // A successful rename flips isGuest to false; clear the previous failure.
    live.renameError = live.renameError || ''
  } else {
    live.renameError = ''
  }
  applyMembers(rawMembers)
}

/** Rename the current user (`/app/user/rename {newName}`); makes a guest a member. */
export async function renameUser(newName) {
  const name = String(newName ?? '').trim()
  if (!name) return { ok: false, confirmed: false, code: 'INVALID', reason: '昵称不能为空' }
  live.renameError = ''
  return commandChannel.send(DEST.rename, { newName: name })
}

/** Legacy idempotent-ish pause toggle (`/app/control/toggle-pause`): works on older servers. */
export async function togglePauseCommand() {
  return commandChannel.send(DEST.togglePause, {})
}

/** Plain-object snapshot of the live state. */
export function snapshotState() {
  return {
    server: live.server,
    sessionBase: sessionBase(),
    capabilities: [...session.capabilities],
    roomName: live.roomName, roomCode: live.roomCode,
    online: live.online, capacity: live.capacity, locked: live.locked,
    playing: live.playing, progress: live.progress,
    config: { ...live.config, privateDj: { ...(live.config.privateDj || {}) } },
    nowPlaying: live.nowPlaying ? { ...live.nowPlaying, cover: { ...live.nowPlaying.cover } } : null,
    queue: live.queue.map((song) => ({ ...song, cover: { ...song.cover } })),
    members: live.members.map((member) => ({ ...member })),
    lyrics: live.lyrics.map((line) => ({ ...line })),
    chat: live.chat.slice(-50).map((message) => ({ ...message }))
  }
}

/** Resolve pending `requestSnapshot()` calls with a fresh snapshot. */
function resolveSnapshotWaiters() {
  if (!snapshotWaiters.length) return
  const snapshot = snapshotState()
  const waiters = snapshotWaiters
  snapshotWaiters = []
  waiters.forEach((waiter) => waiter(snapshot))
}

/** Subscribe every consumed destination; re-run on each (re)connect. */
function subscribeAll() {
  if (!stomp) return
  const add = (destination, handler) => {
    stomp.subscribe(destination, (frame) => {
      let payload
      try {
        payload = JSON.parse(frame.body)
      } catch {
        return
      }
      try {
        handler(payload)
      } catch (error) {
        console.warn(`[live] handler failed for ${destination}`, error)
      }
    })
  }
  add(DEST.state, state => { if (!compact.isActive()) applyPlayerState(state) })
  add(DEST.queue, queue => { if (!compact.isActive()) applyQueue(queue) })
  add(DEST.users, users => { if (!compact.isActive()) applyMembers(users) })
  add(DEST.compact, frame => compact.receive(frame))
  add(DEST.userCompact, frame => compact.receive(frame))
  add(DEST.appCompact, frame => compact.receive(frame))
  add(DEST.events, handleEvent)
  add(DEST.userEvents, handleEvent)
  add(DEST.chat, pushChat)
  add(DEST.userPrivateChat, pushChat)
  add(DEST.userMe, handleMe)
  add(DEST.appMe, handleMe)
  add(DEST.userPong, handlePong)
  add(DEST.userCommandAck, (payload) => {
    commandChannel.handleAck(payload)
  })
  add(DEST.userContainerImport, (payload) => {
    const requestId = String(payload?.requestId || '')
    const pending = pendingImports.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingImports.delete(requestId)
    pending.resolve(payload?.error ? {
      ok: false, confirmed: true, code: 'IMPORT_FAILED', message: String(payload.message || '导入失败'), requestId
    } : {
      ok: true, confirmed: true, code: 'OK', message: String(payload.message || '导入完成'), requestId,
      total: Number(payload.total) || 0, added: Number(payload.added) || 0,
      duplicates: Number(payload.duplicates) || 0, limited: Number(payload.limited) || 0
    })
  })
  add(DEST.userClaim, payload => {
    const requestId = String(payload?.requestId || '')
    const pending = pendingClaims.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingClaims.delete(requestId)
    if (!payload?.error && payload?.member) handleMe(payload.member)
    pending.resolve({ ok: !payload?.error, confirmed: true, code: payload?.error ? 'CLAIM_FAILED' : 'OK',
      message: String(payload?.message || ''), claimed: Number(payload?.claimed) || 0, requestId })
  })
  add(DEST.userChatHistory, (history) => Array.isArray(history) && history.forEach(row => pushChat(row, true)))
  add(DEST.appChatHistory, (history) => {
    if (!Array.isArray(history)) return
    const sessionRows = live.sessionChat.slice()
    live.chat = []
    history.forEach(row => pushChat(row, true))
    for (const row of sessionRows) {
      const index = live.chat.findIndex(item => item.id === row.id)
      if (index >= 0) live.chat[index] = row
      else live.chat.push(row)
    }
    if (live.chat.length > MAX_CHAT) live.chat.splice(0, live.chat.length - MAX_CHAT)
  })
}

/**
 * STOMP CONNECTED: mark connected, replay subscriptions and request one explicit full
 * snapshot (join / reconnect recovery — never as a periodic RTT probe, D-06).
 */
function handleConnect() {
  live.connected = true
  live.joined = true
  live.joining = false
  live.reconnecting = false
  live.error = null
  fatalAuth = false
  lastPlaybackVersion = -1
  compact.reset()
  live.compactSync = false
  compactClock = createRoomClock()
  markSessionConnected()
  subscribeAll()
  startTickers()
  startLatencyProbe()
  // Explicit snapshot on join/recovery (a single resync; the server broadcasts the state).
  setTimeout(() => {
    if (!stomp?.connected) return
    try {
      stomp.publish({ destination: DEST.resync })
      stomp.publish({ destination: DEST.compactResync })
    } catch {
      /* snapshot will arrive with the next state frame */
    }
  }, 250)
}

/** WebSocket closed: keep data and flag reconnecting unless intentional/fatal. */
function handleClose() {
  live.connected = false
  stopTickers()
  stopLatencyProbe()
  rejectPendingCommands('连接已断开，命令未确认')
  live.reconnecting = !(intentionalClose || fatalAuth)
}

/** STOMP ERROR frame (INVALID_ROOM_PASSWORD is fatal). */
function handleStompError(frame) {
  const message = `${frame?.headers?.message || ''} ${frame?.body || ''}`.trim()
  console.warn('[live] STOMP error:', message)
  if (message.includes('INVALID_ROOM_PASSWORD')) return shutdownWithError('房间密码错误（INVALID_ROOM_PASSWORD）')
  if (message.includes('RATE_LIMITED')) return shutdownWithError('尝试次数过多，请稍后再连接房间')
  if (!live.connected) live.error = message || 'STOMP 连接错误'
}

/** Reset the session and surface the fatal reason afterwards. */
function shutdownWithError(message) {
  fatalAuth = true
  pendingError = message
  void teardownSession()
}

/** Poll `predicate` until true or timeout. */
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const poll = () => {
      if (predicate()) return resolve(true)
      if (Date.now() - started >= timeoutMs) return resolve(false)
      setTimeout(poll, 80)
    }
    poll()
  })
}

/**
 * Fire a command.
 *
 * Returns a structured `{ok, confirmed, code, message?, retryAfterMs?, reason?}` object.
 * With the v2 `command-ack` capability the promise resolves when the server ACKs (or
 * after ~1.5s as "unconfirmed"); old servers resolve immediately as unconfirmed and the
 * UI must never show a hard success before the queue/state frame confirms it (D-15).
 *
 * @param {string} destination
 * @param {Record<string, any>} [body]
 * @returns {Promise<import('./commands.js').CommandResult>}
 */
export async function publishCommand(destination, body) {
  return commandChannel.send(destination, body)
}

/** Import a server-side public container and await its point-to-point result. */
export function importContainer(platform, collectionType, containerId) {
  if (!stomp?.connected) return Promise.resolve({ ok: false, confirmed: false, code: 'OFFLINE', reason: '连接已断开，导入未发送' })
  if (live.identity?.isGuest) return Promise.resolve({ ok: false, confirmed: false, code: 'GUEST', reason: '请先设置昵称成为成员' })
  const requestId = defaultRequestId()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingImports.delete(requestId)
      resolve({ ok: false, confirmed: false, code: 'TIMEOUT', reason: '服务器导入请求超时', requestId })
    }, 45000)
    pendingImports.set(requestId, { resolve, timer })
    try {
      stomp.publish({ destination: DEST.enqueueContainer, body: JSON.stringify({ platform, collectionType, containerId, requestId }) })
    } catch (error) {
      clearTimeout(timer)
      pendingImports.delete(requestId)
      resolve({ ok: false, confirmed: false, code: 'OFFLINE', reason: `导入发送失败：${String(error?.message || error)}`, requestId })
    }
  })
}

export function claimOwnerPlaylist(sourceToken) {
  if (!stomp?.connected) return Promise.resolve({ ok: false, confirmed: false, code: 'OFFLINE', reason: '连接已断开' })
  const requestId = defaultRequestId()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingClaims.delete(requestId)
      resolve({ ok: false, confirmed: false, code: 'TIMEOUT', reason: '等待认领结果超时，请先查看队列', requestId })
    }, 15000)
    pendingClaims.set(requestId, { resolve, timer })
    try { stomp.publish({ destination: DEST.claim, body: JSON.stringify({ sourceToken, requestId }) }) }
    catch (error) {
      clearTimeout(timer)
      pendingClaims.delete(requestId)
      resolve({ ok: false, confirmed: false, code: 'OFFLINE', reason: '认领请求发送失败', requestId })
    }
  })
}

/**
 * Resolve every pending command as failed (connection closed / session teardown).
 * @param {string} [reason]
 * @returns {void}
 */
export function rejectPendingCommands(reason = '连接已关闭，命令未确认') {
  commandChannel.rejectAll(reason)
  for (const [requestId, pending] of pendingImports) {
    clearTimeout(pending.timer)
    pending.resolve({ ok: false, confirmed: false, code: 'OFFLINE', reason, requestId })
  }
  pendingImports.clear()
  for (const [requestId, pending] of pendingClaims) {
    clearTimeout(pending.timer)
    pending.resolve({ ok: false, confirmed: false, code: 'OFFLINE', reason, requestId })
  }
  pendingClaims.clear()
}

/** Number of commands waiting for ACK (diagnostics/tests). */
export function pendingCommandCount() {
  return commandChannel.pendingCount()
}

/** Song / raw Music / id → `{ id, platform }`. */
export function resolveMusicTarget(input) {
  if (!input) return null
  if (typeof input === 'string') {
    const cached = searchCache.get(input)
    if (cached) return { id: cached.id, platform: cached.source }
    const queued = live.queue.find((song) => song.id === input || song.queueId === input)
    if (queued) return { id: queued.id, platform: queued.source }
    return { id: input, platform: null }
  }
  const id = String(input.musicId || input.id || '')
  return id ? { id, platform: input.source || input.platform || null } : null
}

/** Song / queue id / music id → queue id. */
export function resolveQueueId(input) {
  if (!input) return null
  if (typeof input === 'string') {
    const byQueue = live.queue.find((song) => song.queueId === input)
    if (byQueue) return byQueue.queueId
    return live.queue.find((song) => song.id === input)?.queueId || null
  }
  if (input.queueId) return input.queueId
  return live.queue.find((song) => song.id === input.id)?.queueId || null
}

/** Cache search results so a bare string id can be enqueued later. */
export function cacheSongs(songs) {
  if (!Array.isArray(songs)) return
  songs.forEach((song) => searchCache.set(song.id, song))
}

/**
 * Register a final session-end callback (D-14).
 *
 * Fires for every **final** teardown — explicit `leaveRoom()`, fatal auth/protocol
 * errors, server switch, PASSWORD_CHANGED — after the session state was reset. It does
 * NOT fire for short reconnects (`live.reconnecting`), where buffered audio keeps
 * playing by design.
 *
 * @param {(info: { reason: string, error: string }) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onSessionEnd(listener) {
  if (typeof listener !== 'function') return () => {}
  sessionEndListeners.push(listener)
  return () => {
    sessionEndListeners = sessionEndListeners.filter((item) => item !== listener)
  }
}

/** Raw STOMP session teardown steps shared by `connectRealtime` failure/timeout. */
async function deactivateTransport(active) {
  if (!active) return
  let timeout
  try {
    const graceful = active.deactivate()
    const completed = await Promise.race([
      graceful.then(() => true),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1500) })
    ])
    if (!completed) {
      // A dead broker may never acknowledge DISCONNECT; abandon the socket so the UI can leave.
      void active.deactivate({ force: true }).catch(() => {})
    }
  } catch (error) {
    console.warn('[live] deactivate failed:', error?.message)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Open the STOMP session (assumes `live` has been reset and `session.beginSession()`
 * was called by the caller) and wait for either CONNECTED or a fatal error.
 * Returns true on success.
 *
 * @param {{ serverUrl?: string, name?: string, password?: string }} [options]
 * @returns {Promise<boolean>}
 */
export async function connectRealtime({ serverUrl, name, password } = {}) {
  intentionalClose = false
  fatalAuth = false
  const base = sessionBase() || normalizeServerUrl(serverUrl) || DEFAULT_SERVER
  const connectHeaders = {
    'user-name': name || '游客',
    'user-token': legacyToken,
    'user-recovery-key': recoveryKey,
    'room-password': String(password ?? ''),
    client: 'desktop/0.2.0'
  }
  const connecting = new Client({
    brokerURL: wsUrl(base),
    connectHeaders,
    heartbeatIncoming: 10000,
    heartbeatOutgoing: 10000,
    reconnectDelay: 2000,
    maxReconnectDelay: 30000,
    reconnectTimeMode: ReconnectionTimeMode.EXPONENTIAL,
    connectionTimeout: 8000,
    onConnect: () => { if (stomp === connecting) handleConnect() },
    onWebSocketClose: () => { if (stomp === connecting) handleClose() },
    onStompError: frame => { if (stomp === connecting) handleStompError(frame) },
    onWebSocketError: (event) => console.warn('[live] WebSocket error:', event?.message || event)
  })
  stomp = connecting
  connecting.activate()
  const settled = await waitFor(() => stomp !== connecting || live.connected || Boolean(live.error), 10000)
  if (stomp !== connecting) return false
  if (settled && live.connected) return true
  if (!live.error) live.error = '连接超时：无法建立 STOMP 会话'
  live.joining = false
  live.joined = false
  live.reconnecting = false
  const failed = stomp
  stomp = null
  await deactivateTransport(failed)
  return false
}

/**
 * Tear down the session, clear `live`, then re-apply a pending fatal error and notify
 * the lifecycle listeners exactly once (D-14).
 *
 * @returns {Promise<void>}
 */
let teardownPromise = null
export function teardownSession() {
  if (teardownPromise) return teardownPromise
  teardownPromise = performTeardown().finally(() => { teardownPromise = null })
  return teardownPromise
}

async function performTeardown() {
  // A visible live session may exist even when the frozen base was cleared elsewhere
  // (e.g. test harnesses set `live.joined` directly); the lifecycle callback must fire
  // in that case too so audio/lyrics never keep running after a final teardown (D-14).
  const hadSession = Boolean(sessionBase()) || Boolean(live.joined) || Boolean(stomp)
  intentionalClose = true
  stopTickers()
  stopLatencyProbe()
  rejectPendingCommands('连接已关闭，命令未确认')
  const active = stomp
  stomp = null
  await deactivateTransport(active)
  rawMembers = []
  myPublicId = ''
  lastPlaybackVersion = -1
  compact.reset()
  live.compactSync = false
  compactClock = createRoomClock()
  searchCache.clear()
  snapshotWaiters = []
  // Invalidate in-flight lyrics before clearing the state (they must not land later).
  invalidateLyrics()
  clearRoomAccess()
  // The in-memory admin session is bound to this server: always drop it on teardown.
  adminLogout()
  const fatalMessage = pendingError || ''
  if (sessionBase()) endSession()
  resetLive()
  if (fatalMessage) live.error = fatalMessage
  pendingError = null
  intentionalClose = false
  fatalAuth = false
  if (hadSession) {
    const info = { reason: fatalMessage ? 'fatal' : 'left', error: fatalMessage }
    for (const listener of [...sessionEndListeners]) {
      try {
        listener(info)
      } catch (error) {
        console.warn('[live] session-end listener failed:', error?.message)
      }
    }
  }
}

/**
 * Force a fresh authoritative snapshot (`/app/player/resync` broadcasts to the whole
 * room) and resolve with it; falls back to local state after 2s.
 *
 * Only used for **explicit** snapshot requests (join / manual resync), never as a
 * periodic latency probe (D-06).
 * @returns {Promise<Object>}
 */
export async function requestSnapshot({ requireFresh = false } = {}) {
  if (!stomp?.connected) return requireFresh ? null : snapshotState()
  const snapshot = new Promise((resolve) => {
    const wrapped = (value) => {
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      snapshotWaiters = snapshotWaiters.filter((waiter) => waiter !== wrapped)
      resolve(requireFresh ? null : snapshotState())
    }, 2000)
    snapshotWaiters.push(wrapped)
  })
  stomp.publish({ destination: compact.isActive() ? DEST.compactResync : DEST.resync })
  return snapshot
}

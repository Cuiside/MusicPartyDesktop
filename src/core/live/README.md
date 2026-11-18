# MusicParty Desktop · Live Client (`src/core/live/`)

Self-contained realtime client for the MusicParty backend: **HTTP (axios) + STOMP over
WebSocket (`@stomp/stompjs`)**. It owns one room session per renderer and writes every
server frame into the Vue reactive `live` object that the UI can bind to directly.

No UI component, `App.vue`, `package.json` or dependency was modified by this module.

## Files

| File | Role |
|---|---|
| `config.js` | `DEFAULT_SERVER`, settings persistence (`mp.desktop.settings`), `httpBase()` / `wsUrl()` / `serverHost()` |
| `state.js` | reactive `live` state + `resetLive()` |
| `mapping.js` | server DTO → UI shapes (`toSong`, `toQueueItem`, `toMember`, `toChatMessage`, `toLyricLines`, `toConfig`, `coverFor`) |
| `client.js` | public API (`joinRoom`, `leaveRoom`, commands, `search`, `getLyrics`, `getRoomSnapshot`) |
| `transport.js` | **internal**: the single STOMP connection, topic handlers, reconnect/teardown, latency, snapshot |
| `api.js` | **internal**: HTTP pre-flight, search, lyrics, `/api/config` |

Internal modules are not meant to be imported by UI code; use `client.js` + `state.js`.

## Protocol (verified against docs **and** the running backend)

### STOMP transport

| Item | Value |
|---|---|
| Endpoint | `ws(s)://<host>/ws` — bare WebSocket, **not SockJS** |
| CONNECT headers | `user-name`, `user-token` (stable UUID), `room-password` |
| Password check | Only the STOMP CONNECT frame is authoritative; REST stays open |
| Heartbeat | incoming/outgoing 10 000 ms (server also announces `10000,10000`) |
| Application prefix | `/app`; broker prefixes `/topic`, `/queue`, user prefix `/user` |
| Reconnect | `@stomp/stompjs` exponential backoff, 2 s → 4 s → … → 30 s |
| Ack | No acks / requestIds anywhere; results are observed through state frames |

Wrong password ⇒ `ERROR` frame containing `INVALID_ROOM_PASSWORD` (connection dropped).
A `PASSWORD_CHANGED` event means the room password changed and a reconnect/re-join is
required; the client tears down and surfaces `live.error`.

### Subscriptions actually used

| Destination | Payload | Handling |
|---|---|---|
| `/topic/player/state` | `PlayerState` (plus `@SubscribeMapping` initial snapshot) | `applyPlayerState` |
| `/topic/player/queue` | `MusicQueueItem[]` | `applyQueue` |
| `/topic/users/online` | `UserSummary[]` (initial snapshot only; the server never broadcasts here) | `applyMembers` |
| `/topic/player/events` | `PlayerEvent {type, action, userId, message, payload}` | activity + password-change detection |
| `/topic/chat` | `ChatMessage {id,userId,userName,content,timestamp,type}` | chat/system/song rows |
| `/user/queue/events` | `PlayerEvent` (this session only) | same event handler |
| `/user/queue/chat/private` | `ChatMessage` (`//stream` token) | chat row |
| `/user/queue/chat/history` | `ChatMessage[]` (reply to `/app/chat/history/fetch`) | chat rows |
| `/app/chat/history` | `ChatMessage[]` (subscription snapshot, last 50) | replaces `live.chat` |
| `/app/user/me` | `UserSummary` (subscription snapshot) | token/identity sync |
| `/user/queue/me` | `UserSummary` (after rename) | identity sync |

**There is no song-history topic and no history endpoint.** `PlayerState.config.maxHistorySize`
is just the server-side retained count. `live.activity` is derived from system chat rows and
`ERROR` player events; the History view cannot be fed from this module.

### Commands sent

| Destination | Body | Client function |
|---|---|---|
| `/app/player/resync` | `{}` | `getRoomSnapshot()`, latency probe |
| `/app/enqueue` | `{"platform":"netease"\|"bilibili","musicId":"…"}` | `addToQueue` |
| `/app/control/next` | `{}` | `skip`, `voteSkip` |
| `/app/control/set-paused` | `{"paused":true\|false}` | `togglePlay` (idempotent; verified `SetPausedRequest` in the jar) |
| `/app/control/like` | `{"position":<ms>}` | `like` (only the current track) |
| `/app/queue/top` | `{"queueId":"…"}` | `pin` |
| `/app/queue/remove` | `{"queueId":"…"}` | `removeFromQueue` |
| `/app/chat` | `{"content":"…"}` | `sendChat` (`//` starts server commands) |

There is **no** separate vote-skip destination; the server interprets
`/app/control/next` as a vote when vote-skip is enabled. `//stream` is the only way to mint
a live-stream token and is not implemented here.

### HTTP endpoints used

| Method / path | Purpose |
|---|---|
| `GET /api/auth/status` | `{isSetup, hasProtection}` pre-flight |
| `POST /api/auth/verify` | `{password}` → `{valid}` (401 / 429 rate-limited) |
| `GET /api/config` | cosmetic (`authorName`, `backWords`) + one latency sample |
| `GET /api/search/{platform}/{keyword}` | `Music[]` (no pagination; bilibili ≤ 20) |
| `GET /api/music/lyric/{platform}/{musicId}` | JSON **string** containing LRC (bilibili always `""`) |

`POST /api/auth/setup` is **not** called automatically. For a fresh server the intended
flow is `isSetup:false` → `POST /api/auth/setup {"password":"…"}`; this desktop client
assumes the room has already been set up (or is public) and only verifies the password.

### Key payload fields (units!)

- `Music`: `id`, `name`, `artists[]`, `duration` **ms**, `platform` (`netease`/`bilibili`), `coverUrl`.
- `MusicQueueItem`: `queueId`, `music`, `enqueuedBy{token,sessionId,name,isGuest}`, `status`
  (`PENDING|DOWNLOADING|READY|PLAYING|FAILED`), `priority` (`GLOBAL_TOP|USER_TOP|REGULAR`).
- `PlayerState.nowPlaying`: `music` (`PlayableMusic` with `url`/`needsProxy`), `currentPosition` **ms**,
  `enqueuedById`, `enqueuedByName`, `likedUserIds[]`, `likeMarkers[]`.
- `PlayerState`: `queue[]`, `onlineUsers[]`, `isPaused`, `isPauseLocked`, `isSkipLocked`,
  `isPlayModeLocked`, `playMode`, `config`, `serverTime`, `playbackVersion`,
  `positionAnchorMs`, `anchorSetAtMs`.
- `ChatMessage.type`: `CHAT | SYSTEM | LIKE | PLAY_START`.
- Private-FM placeholder queue items (`music.id === "netease-fm"`, token `__FM__`) are filtered out.

## State shape

```js
live = {
  connected, joined, joining, reconnecting, error, latency,   // latency = ms RTT
  server, roomName, roomCode, online, capacity, locked, admin,
  config,                    // normalized PlayerState.config
  playing, progress,         // progress in SECONDS, interpolated locally every 1s
  nowPlaying, queue, members, chat, lyrics, activity
}
```

`resetLive()` resets every field in place (same reactive proxy).

### Song shape

```js
{
  id,                        // music id (never the queue id)
  queueId,                   // extra field: needed for pin/remove; null for search/nowPlaying
  title, artist, album,      // album is always null (not in the server DTO)
  source, sourceLabel,       // 'netease'|'bilibili', '网易云'|'B站'
  duration,                  // SECONDS (server ms rounded)
  quality,                   // presentation-only fallback
  requestedBy, liked, likedByMe, pinned, state,
  progress, addedAt, playedAt,
  cover: { bg, fg, mark, sub, tag }   // deterministic CSS cover, no image URL
}
```

`state`: `'playing' | 'paused' | 'queued'`. `queueId` and `album` are not in the
original UI contract but are harmless additions; everything else matches it.

### Fields the server does not provide (UI must fall back)

| Field | Value / fallback |
|---|---|
| `roomName` | `` `${server} 房间` `` (cosmetic; the server has no room name) |
| `roomCode` | `null` |
| `capacity` | `0` = unknown (no capacity concept server-side) |
| `admin` | `false` (admin API is not wired) |
| `song.album` / `addedAt` / `playedAt` | `null` |
| `song.quality` | synthetic per platform (`极高 · 320k` / `视频音轨`) |
| `song.liked` for queue items | `0` (likes only exist for `nowPlaying`) |
| `members[].status` | `'在听'`; role is `成员` / `游客` (no host/admin role exists) |
| `live.config` before the first state frame | `{}`; `toConfig` fills documented defaults on the first frame |
| history (`HistoryView`) | not available over the protocol |

## Export signatures

### `client.js`

```js
joinRoom({ name?, password?, serverUrl? }): Promise<boolean>
leaveRoom(): Promise<void>
search(platform, keyword): Promise<LiveSong[]>            // throws on HTTP/network error
addToQueue(musicOrId): boolean
removeFromQueue(queueIdOrSong): boolean
togglePlay(playing?): boolean                            // desired state, defaults to !live.playing
skip(): boolean
voteSkip(): boolean                                      // same destination as skip()
like(musicOrId?): boolean                                // only live.nowPlaying
pin(musicOrId): boolean
sendChat(text): boolean
getLyrics(song): Promise<LyricLine[]>                    // also writes live.lyrics
getRoomSnapshot(): Promise<Snapshot>                     // triggers a room-wide resync
```

`musicOrId` accepts a mapped song object, a raw `Music`-like object (`{platform,id}`) or a
string id (search results are cached by `search()`; queue ids/music ids are resolved from
`live.queue`).

### `config.js`

```js
DEFAULT_SERVER // 'http://127.0.0.1:8080'
SETTINGS_KEY   // 'mp.desktop.settings'
normalizeServerUrl(value): string
loadSettings(): { serverUrl, mode: 'local'|'remote', userName }
saveSettings(partial): { serverUrl, mode, userName }
httpBase(serverUrl?): string
wsUrl(serverUrl?): string
serverHost(serverUrl?): string
```

The room password is **not** persisted. `localStorage` is used when available, with an
in-memory fallback for Node tests.

### `state.js`

```js
live           // reactive state described above
resetLive()    // reset in place
```

### `mapping.js`

```js
toSong(raw, opts?): LiveSong
toQueueItem(raw, opts?): LiveSong
toMember(raw, { myToken?, status? }?): { name, role, status, you }
toChatMessage(raw, { myToken?, nowPlaying?, roleOf? }?): LiveChatMessage
toLyricLines(raw): { t, text, trans? }[]   // t in seconds
toConfig(raw): Object
coverFor(title, { source? }?): { bg, fg, mark, sub, tag }
formatClock(value?): string                // 'HH:mm'
normalizePlatform(platform?): 'netease'|'bilibili'
platformMeta(platform?): { label, tag, quality }
```

## Minimal `App.vue` integration (example only — not applied)

```vue
<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { live } from './core/live/state'
import { joinRoom, leaveRoom, togglePlay, skip, getLyrics } from './core/live/client'
import { saveSettings } from './core/live/config'

onMounted(async () => {
  saveSettings({ serverUrl: 'http://127.0.0.1:8080', mode: 'local', userName: '你' })
  const ok = await joinRoom({ name: '你', password: '' })
  if (!ok) console.warn('[live] join failed:', live.error)
})

onBeforeUnmount(() => { void leaveRoom() })

// The current RoomInspector expects an object like demo.room:
const room = computed(() => ({
  name: live.roomName || 'MusicParty',
  code: live.roomCode || '—',
  online: live.online,
  capacity: live.capacity || null,
  latency: live.latency,
  locked: live.locked,
  server: live.server,
  mode: '实时',
  queueCount: live.queue.length,
  historyCount: 0
}))

// Keep the existing playback store in sync with server truth:
// watch(() => live.playing, (v) => { playback.playing = v })
// watch(() => live.progress, (v) => { playback.progress = v })
// watch(() => live.nowPlaying?.id, (id) => { if (id) getLyrics(live.nowPlaying) })
</script>

<template>
  <span>{{ live.connected ? '在线' : live.reconnecting ? '重连中…' : '离线' }}</span>
  <span>{{ live.latency }}ms</span>

  <article v-if="live.nowPlaying">
    <h2>{{ live.nowPlaying.title }}</h2>
    <p>{{ live.nowPlaying.artist }} · {{ live.nowPlaying.sourceLabel }}</p>
    <button @click="togglePlay(!live.playing)">{{ live.playing ? '暂停' : '播放' }}</button>
    <button @click="skip()">切歌</button>
  </article>

  <ul>
    <li v-for="song in live.queue" :key="song.queueId || song.id">
      {{ song.title }} — {{ song.artist }} ({{ song.requestedBy || '—' }})
    </li>
  </ul>
</template>
```

For the current demo-driven views, the mapping to `demo.room` / `demo.queue` is just a
`computed` wrapper like above; `live.queue` already uses the same field names as
`demo.queue` (`title`, `artist`, `duration` seconds, `requestedBy`, `likedByMe`, `cover`).

## Known limitations & risks

1. **HTTP CORS blocks REST inside Electron.** The backend has no CORS configuration at all
   (`no CorsRegistry`, no `@CrossOrigin`). In dev (`http://localhost:5173`) and production
   (`file://`) the renderer is cross-origin to `http://127.0.0.1:8080`, so
   `/api/auth/*`, `/api/config`, `/api/search/*` and lyrics are rejected by Chromium.
   STOMP/WebSocket is unaffected (the server allows all origins on `/ws`), and
   `joinRoom()` deliberately falls back to the CONNECT frame when the HTTP pre-flight
   fails. Consequences: **join/chat/state/reconnect work, but `search()` and `getLyrics()`
   fail until one of these is done by the app shell (outside this module):**
   - add a Vite dev proxy for `/api` and `/ws` (`ws: true`) and point `serverUrl` at the
     Vite origin, or
   - serve the built renderer from the backend origin, or
   - add CORS headers on the backend (read-only repo — not done here), or
   - expose REST through a preload/IPC bridge.

   Do **not** disable `webSecurity` in production as a fix.

2. **No song history API/topic** — `HistoryView` cannot be real; `playedAt` is always null.
3. **No room metadata** — name/code/capacity/admin are synthetic or null (table above).
4. **No acks** — every command is fire-and-forget. Silent failures include guest writes,
   pause/skip locks, control cooldown, duplicate likes, queue-full, chat cooldown and
   over-length messages. The UI must rely on state frames / events / activity.
5. **Likes only target the current track**; `like(otherId)` returns `false` locally.
6. **Vote skip has no dedicated command** — `voteSkip()` is `skip()`; the server decides.
7. **`set-paused` requires a recent backend** (present in this repo's jar). Older servers
   only expose the non-idempotent `toggle-pause`; `togglePlay()` would then fail silently.
8. **Search/lyrics are HTTP-only** (CORS caveat above). Bilibili lyrics are always empty;
   search errors are 502 with `{message}` and surfaced as thrown `Error`.
9. **No private FM/DJ, stream token, admin, playlist import, rename or bind** in this module.
   Private-FM placeholder queue items are filtered out.
10. **Latency probe uses `/app/player/resync` every 30s**, which broadcasts a full state
    frame to the whole room. Remove it for quiet rooms if that is unacceptable.
11. **Chat history snapshot replaces `live.chat` on every (re)connect**, so messages that
    were never persisted server-side can disappear after a reconnect (observed 8 → 6 in
    the reconnect test).
12. **`playbackVersion` frames are versioned**: older frames are dropped; on a server that
    does not send `playbackVersion` the rule is disabled automatically.
13. **The backend persists state** in `data/queue-data.json` (relative to its working
    directory): queue, chat history, locks, play mode, system config **and the room
    password** (`settings.roomPassword`). A restart therefore restores the password and
    previously queued/chat data; it is not purely in-memory in this build. Delete that file
    for a truly fresh room during tests.
14. **Room password is not persisted** by this module; the UI must ask for it again.
15. **`PLAY_START` chat rows become song cards only if `live.nowPlaying` is already the new
    track**; otherwise they degrade to a system line (the protocol only carries the title).
16. **`user-token` is an identity, not a credential** — the server accepts whatever the
    client asserts and broadcasts tokens to everyone.
17. **`POST /api/auth/setup` is never called automatically.** On a brand-new server
    (`isSetup:false`) the room is open and STOMP accepts any client, so joining works but
    the room stays uninitialized. A first-run setup UI must call `/api/auth/setup` itself
    (outside this module's scope).

## Quick smoke check

```bash
node --check src/core/live/client.js
# see the integration report: join → snapshot → chat → latency → leave (28/28),
# protected-room auth (10/10), kill/restart reconnect (9/9)
```

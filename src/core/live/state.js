/**
 * Central reactive state for the live MusicParty connection.
 *
 * The UI reads this object directly (`import { live } from './live/state'`).
 * All fields are kept in the UI-friendly shapes documented in `README.md`:
 * durations/progress are in **seconds**, server payloads (milliseconds) are
 * normalized by `mapping.js`.
 *
 * @module core/live/state
 */

import { reactive } from 'vue'

/**
 * @typedef {Object} LiveCover
 * @property {string} bg Background color.
 * @property {string} fg Foreground color.
 * @property {string} mark 1-3 character typographic mark.
 * @property {string} sub Uppercase caption.
 * @property {'NETEASE' | 'BILIBILI'} tag Source tag.
 */

/**
 * @typedef {Object} LiveSong
 * @property {string} id Music id (never the queue id).
 * @property {string | null} queueId Queue id when the song comes from the queue.
 * @property {string} title
 * @property {string} artist
 * @property {string | null} album Always `null` for live data (not in server DTO).
 * @property {'netease' | 'bilibili'} source
 * @property {string} sourceLabel
 * @property {number} duration **Playable** duration in seconds (playableDurationMs when
 *   the server reports it, else the song duration; `0` when unknown). All progress
 *   anchoring / duration labels use this value, never the full track length of a trial.
 * @property {number} playableDuration Seconds actually playable (= duration).
 * @property {number} fullDuration Full track duration in seconds (differs from
 *   `duration` for trial clips; equals it for full tracks / old servers).
 * @property {boolean} trial Server flagged the stream as a trial/preview clip (S-01).
 * @property {string | null} urlType `FULL | TRIAL | UNAVAILABLE | ERROR` when reported.
 * @property {string} quality Presentation-only fallback.
 * @property {string | null} requestedBy
 * @property {number} liked
 * @property {boolean} likedByMe
 * @property {boolean} pinned
 * @property {string} state `'playing' | 'paused' | 'queued'`
 * @property {number} [progress] Seconds (now playing only).
 * @property {string | null} addedAt Always `null` (no enqueue timestamp in server DTO).
 * @property {string | null} playedAt Always `null` (no history API/topic).
 * @property {LiveCover} cover
 */

/**
 * @typedef {Object} LiveMember
 * @property {string} name
 * @property {string} role
 * @property {string} status
 * @property {boolean} you
 */

/**
 * @typedef {Object} LiveChatMessage
 * @property {string} id
 * @property {'chat' | 'system' | 'song'} type
 * @property {string} time `HH:mm`
 * @property {string} user
 * @property {string | null} role
 * @property {string} text
 * @property {boolean} [command]
 * @property {boolean} [me]
 * @property {LiveSong} [song]
 */

/**
 * @typedef {Object} LiveState
 * @property {boolean} connected WebSocket/STOMP is currently connected.
 * @property {boolean} joined Room session considered usable (kept true while reconnecting).
 * @property {boolean} joining A join attempt is in flight.
 * @property {boolean} reconnecting Connection dropped and automatic retry is running.
 * @property {string | null} error Last connection/auth error (UI may show it).
 * @property {number} latency Round-trip estimate in milliseconds.
 * @property {string} server `host:port` **display** label (never used to build URLs).
 * @property {string} sessionBase Frozen full base of the current session (`scheme://host[/prefix]`).
 * @property {string[]} capabilities Protocol v2 capability strings advertised by `/api/config`.
 * @property {boolean | null} adminConfigured Server `/api/config.adminConfigured` (null = unknown/old server).
 * @property {string} serverVersion Server version string when reported.
 * @property {string} roomName Cosmetic name (server has no room name; derived from `/api/config`).
 * @property {string | null} roomCode Always `null` (server has no room code).
 * @property {number} online Number of online users.
 * @property {number} capacity `0` = unknown (server has no capacity concept).
 * @property {boolean} locked `true` when any action lock is engaged.
 * @property {boolean} admin Always `false` (admin API is not wired).
 * @property {Object} config Server `PlayerState.config`, normalized.
 * @property {boolean} playing
 * @property {number} progress Seconds, locally interpolated between state frames.
 * @property {LiveSong | null} nowPlaying
 * @property {LiveSong[]} queue
 * @property {LiveMember[]} members
 * @property {{ id: string, name: string, isGuest: boolean, recoveryKey?: string } | null} identity
 *   Authoritative identity from `/user/queue/me`. `id` is the public id used for member
 *   matching / `likedByMe`; `recoveryKey` (v2) is stored locally and never displayed.
 * @property {LiveChatMessage[]} chat
 * @property {{ t: number, text: string, trans?: string }[]} lyrics
 * @property {{ time: string, text: string }[]} activity
 */

/**
 * Fresh state object (also used by {@link resetLive}).
 * @returns {LiveState}
 */
function initialState() {
  return {
    connected: false,
    joined: false,
    joining: false,
    reconnecting: false,
    error: null,
    latency: 0,
    server: '',
    sessionBase: '',
    capabilities: [],
    adminConfigured: null,
    serverVersion: '',
    roomName: '',
    roomCode: null,
    online: 0,
    capacity: 0,
    locked: false,
    admin: false,
    config: {},
    playing: false,
    playMode: null,
    compactSync: false,
    playbackId: null,
    loading: false,
    playModeLocked: false,
    progress: 0,
    nowPlaying: null,
    queue: [],
    members: [],
    identity: null,
    renameError: '',
    chat: [],
    sessionChat: [],
    lyrics: [],
    activity: []
  }
}

/**
 * Global reactive live state. Mutated exclusively by `client.js` and `mapping.js`.
 * @type {LiveState}
 */
export const live = reactive(initialState())

/**
 * Reset every field of {@link live} in place (keeps the same reactive proxy so
 * components that already imported it keep working).
 * @returns {void}
 */
export function resetLive() {
  Object.assign(live, initialState())
}

/**
 * Immutable **session base** for the live connection (D-08 / D-12 / D-16).
 *
 * A room session fixes one fully-normalized base URL (`scheme://host[/pathPrefix]`)
 * at join time. Every REST / WebSocket / media / admin request made during the
 * session resolves against this base — never against the mutable "saved address" in
 * settings, and never against the display-only `live.server` host label.
 *
 * Consequences:
 * - editing + saving the address in Settings does not retarget a live session; the
 *   caller must end the session and rejoin (SettingsView does that transactionally);
 * - a server switch cannot leave HTTP on server B while the WebSocket still talks to
 *   server A, because both read the same frozen base;
 * - copying the room address uses {@link sessionAddress}, so scheme and path prefix
 *   survive (D-12).
 *
 * The object is reactive so Settings / admin dialogs can display the effective base
 * and capability set without extra plumbing. `generation` is bumped on every session
 * start/end and lets async work (lyrics requests, pending ACKs, admin verification)
 * detect that it belongs to an earlier session.
 *
 * @module core/live/session
 */

import { reactive } from 'vue'
import { DEFAULT_SERVER, loadSettings, normalizeServerUrl } from './config.js'
import { live } from './state.js'

/** localStorage key for the v2 identity recovery key (secret, never displayed). */
export const RECOVERY_KEY_STORAGE = 'mp.desktop.recovery-key'

/** Legacy identity key (`user-token`); kept for old servers. */
export const LEGACY_TOKEN_STORAGE = 'mp.desktop.token'

/** @typedef {Object} SessionState */

/** @type {SessionState & {
 *   base: string,
 *   generation: number,
 *   connectedAt: number,
 *   capabilities: string[],
 *   adminConfigured: boolean | null,
 *   serverVersion: string,
 *   cookieSource: string,
 *   roomProtectionEnabled: boolean | null,
 *   roomToken: string
 * }} */
export const session = reactive({
  base: '',
  generation: 0,
  connectedAt: 0,
  capabilities: [],
  adminConfigured: null,
  serverVersion: '',
  cookieSource: '',
  roomProtectionEnabled: null,
  roomToken: ''
})

/**
 * Current saved ("next connection") address from localStorage, as a safe fallback.
 * @returns {string}
 */
function savedBase() {
  try {
    return loadSettings().serverUrl || DEFAULT_SERVER
  } catch {
    return DEFAULT_SERVER
  }
}

/**
 * Address to use for a request that may happen outside an active session
 * (e.g. probing the configured server from Settings / admin login before joining).
 * @returns {string}
 */
export function activeBase() {
  return session.base || savedBase()
}

/**
 * Frozen base of the current session, or `''` when not joined.
 * @returns {string}
 */
export function sessionBase() {
  return session.base
}

/**
 * Address suitable for "copy room address" / display of the effective server:
 * the frozen session base while joined, else the saved next-connection address.
 * @returns {string}
 */
export function sessionAddress() {
  return session.base || savedBase()
}

/**
 * Freeze a normalized server base for a new session.
 *
 * Must be called before pre-flight REST calls (`/api/auth/status` → verify), so the
 * verify request already targets the address that STOMP will connect to.
 *
 * @param {string} base Raw or normalized address (invalid input throws a readable error).
 * @returns {string} Normalized frozen base.
 */
export function beginSession(base) {
  const normalized = normalizeServerUrl(base)
  if (!normalized) {
    throw new Error(`无法开始会话：服务器地址无效（${String(base ?? '')}）`)
  }
  session.generation += 1
  session.base = normalized
  session.connectedAt = 0
  session.capabilities = []
  session.adminConfigured = null
  session.serverVersion = ''
  session.cookieSource = ''
  session.roomProtectionEnabled = null
  session.roomToken = ''
  live.sessionBase = normalized
  live.capabilities = []
  live.adminConfigured = null
  return normalized
}

/**
 * End the current session (clears the frozen base, room token and capabilities) and
 * bumps the generation so in-flight async results are dropped.
 *
 * Display fields mirrored on `live` are cleared here as well; {@link resetLive} is
 * still responsible for the rest of the reactive state.
 *
 * @returns {void}
 */
export function endSession() {
  session.generation += 1
  session.base = ''
  session.connectedAt = 0
  session.capabilities = []
  session.adminConfigured = null
  session.serverVersion = ''
  session.cookieSource = ''
  session.roomProtectionEnabled = null
  session.roomToken = ''
  live.sessionBase = ''
  live.capabilities = []
  live.adminConfigured = null
}

/**
 * Mark the STOMP connection as established (used by the connection status UI only).
 * @returns {void}
 */
export function markSessionConnected() {
  session.connectedAt = Date.now()
}

/**
 * Does the connected server advertise a protocol v2 capability?
 *
 * Old servers return only `{ backWords, authorName }`, so capabilities are strictly
 * opt-in: "field exists AND contains the string".
 *
 * @param {string} name e.g. `ping`, `command-ack`, `room-token`, `playable-trial`.
 * @returns {boolean}
 */
export function hasCapability(name) {
  return session.capabilities.includes(String(name ?? ''))
}

/**
 * Replace the capability list from `GET /api/config` (tolerates old servers).
 * @param {unknown} list
 * @returns {void}
 */
export function setCapabilities(list) {
  const next = Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : []
  session.capabilities = next
  live.capabilities = next
}

/**
 * Apply the non-sensitive `/api/config` metadata (capability discovery).
 * @param {any} meta Parsed `/api/config` body.
 * @returns {void}
 */
export function applyConfigMeta(meta) {
  const data = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
  setCapabilities(data.capabilities)
  session.adminConfigured = typeof data.adminConfigured === 'boolean' ? data.adminConfigured : null
  session.serverVersion = typeof data.serverVersion === 'string' ? data.serverVersion : ''
  session.cookieSource = typeof data.cookieSource === 'string' ? data.cookieSource : ''
  session.roomProtectionEnabled =
    typeof data.restProtectionEnabled === 'boolean'
      ? data.restProtectionEnabled
      : typeof data.roomProtectionEnabled === 'boolean'
        ? data.roomProtectionEnabled
        : null
  live.adminConfigured = session.adminConfigured
  live.serverVersion = session.serverVersion
  if (typeof data.neteaseConfigured === 'boolean' && live.config) {
    // Only mirrors a non-sensitive flag, used by Settings when not joined yet.
    live.config.neteaseCookieConfigured = data.neteaseConfigured
  }
}

/**
 * Store the short-lived REST room token returned by `POST /api/auth/verify`.
 * Memory only; never persisted or displayed.
 * @param {unknown} token
 * @returns {void}
 */
export function setRoomToken(token) {
  session.roomToken = typeof token === 'string' ? token.trim() : ''
}

/** Drop the REST room token (401 / session end). @returns {void} */
export function clearRoomToken() {
  session.roomToken = ''
}

/** Does the session currently hold a REST room token? @returns {boolean} */
export function hasRoomToken() {
  return Boolean(session.roomToken)
}

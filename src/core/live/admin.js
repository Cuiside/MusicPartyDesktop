/**
 * Admin configuration API for the MusicParty desktop client.
 *
 * Mirrors the web admin dashboard (`music-party-web/src/api/admin.js`) against the
 * structured REST endpoints exposed by the server's `AdminController`:
 *
 * | Method | Path                        | Body                                             |
 * | ------ | --------------------------- | ------------------------------------------------ |
 * | POST   | `/api/admin/verify`         | `{ password }`                                   |
 * | POST   | `/api/admin/config/cookie`  | `{ platform: 'netease' \| 'bilibili', value }`   |
 * | POST   | `/api/admin/config/update`  | `{ maxSize, historySize, ... }` (see below)      |
 * | POST   | `/api/admin/room/password`  | `{ password }` (empty string = public room)      |
 * | POST   | `/api/admin/room/stream`    | `{ enabled }`                                    |
 * | POST   | `/api/admin/room/clear`     | `{ target: 'QUEUE' \| 'CHAT' \| 'OFFLINE' }`     |
 * | POST   | `/api/admin/system/reset`   | `{}`                                             |
 * | POST   | `/api/admin/player/action`  | `{ action }`                                     |
 * | POST   | `/api/admin/lock`           | `{ type, locked }`                               |
 * | POST   | `/api/admin/private-dj`     | `{ mode, fillBlankEnabled, joinQueueEnabled, custodyEnabled }` |
 *
 * Every authenticated endpoint requires the `X-Admin-Password` header. Requests go
 * through the Electron preload HTTP bridge (`window.mpDesktop.http.request`) when
 * available — the backend sends no CORS headers, so the renderer cannot always use
 * `fetch`. In a plain browser the module falls back to `fetch` and surfaces the
 * CORS/network failure as a user-facing message.
 *
 * Failures are normalized by {@link adminRequest}:
 * - HTTP 403 → `管理员密码错误`
 * - bridge/fetch network failure → `无法连接服务器（地址/网络）`
 * - any other HTTP error → the server's `{ message }` when present, else `请求失败（HTTP <status>）`
 * - HTML body (wrong address / SPA fallback) → `服务器返回了 HTML（该地址可能不是 MusicParty 后端）`
 * - destination differs from the verified server → `管理员认证已失效，请在新服务器重新认证`
 *
 * Successful calls resolve with the parsed server body (`{ message, ... }`).
 *
 * Security (D-08):
 * - the admin password lives ONLY in the in-memory reactive `adminAuth` object; it is
 *   never persisted to `localStorage`/disk and is cleared by {@link adminLogout};
 * - a successful verification is bound to the immutable base it was verified against
 *   (`adminAuth.authenticatedServerBase`); every later request must target the same
 *   base or the credential is dropped instead of being sent to another server;
 * - redirects are rejected (bridge `redirect: 'error'` / fetch `redirect: 'error'`) so
 *   a 30x cannot forward the password header to a different origin.
 *
 * @module core/live/admin
 */

import { reactive } from 'vue'
import { normalizeServerUrl } from './config.js'
import { activeBase } from './session.js'

/** User-facing error for a wrong admin password (HTTP 403). */
export const ADMIN_ERROR_PASSWORD = '管理员密码错误'

/** User-facing error for an unreachable server / refused connection. */
export const ADMIN_ERROR_NETWORK = '无法连接服务器（地址/网络）'

/** User-facing error when the address answers with an HTML page instead of the API. */
export const ADMIN_ERROR_HTML = '服务器返回了 HTML（该地址可能不是 MusicParty 后端）'

/** User-facing error when the target server no longer matches the verified session. */
export const ADMIN_ERROR_SERVER_CHANGED = '管理员认证已失效，请在新服务器重新认证'

/** User-facing error when no admin session exists at all. */
export const ADMIN_ERROR_NOT_VERIFIED = '请先完成管理员认证'

/** User-facing error when a redirect would have carried the credential elsewhere. */
export const ADMIN_ERROR_REDIRECT = '服务器返回了重定向（为保护管理员凭据已拒绝跳转）'

/** Supported platform ids for `POST /api/admin/config/cookie`. */
export const ADMIN_PLATFORMS = ['netease', 'bilibili', 'qqmusic']

/** Supported `action` values for `POST /api/admin/player/action` (server switch). */
export const PLAYER_ACTIONS = ['PAUSE', 'SKIP', 'SHUFFLE', 'TOGGLE_FAIR_SHUFFLE', 'TOGGLE_ALLOW_OFFLINE']

/** Supported `type` values for `POST /api/admin/lock`. */
export const LOCK_TYPES = ['PAUSE', 'SKIP', 'SHUFFLE', 'ALL']

/** Supported `target` values for `POST /api/admin/room/clear`. */
export const CLEAR_TARGETS = ['QUEUE', 'CHAT', 'OFFLINE']

/** Supported private radio modes (`mode` = the on/off switch itself). */
export const PRIVATE_DJ_MODES = ['OFF', 'FM', 'DJ']

/**
 * In-memory administrator session. The password is deliberately NOT persisted:
 * a renderer reload / app restart means re-authenticating.
 *
 * `authenticatedServerBase` pins the verification to one immutable server base
 * (scheme + host + proxy path prefix). It is empty until {@link verifyAdmin} succeeds.
 *
 * @type {{ password: string, verified: boolean, verifying: boolean, error: string, authenticatedServerBase: string }}
 */
export const adminAuth = reactive({
  password: '',
  verified: false,
  verifying: false,
  error: '',
  authenticatedServerBase: ''
})

/**
 * Normalize the request target base for this admin call.
 * @param {{ base?: string }} [options]
 * @returns {string}
 */
function targetBase(options = {}) {
  const raw = options.base != null && String(options.base).trim() ? options.base : activeBase()
  const normalized = normalizeServerUrl(raw)
  if (!normalized) throw new Error(`服务器地址无效：${String(raw ?? '')}`)
  return normalized
}

/**
 * Does the in-memory admin session belong to this exact server base?
 * @param {string} [base]
 * @returns {boolean}
 */
export function isAdminSessionFor(base) {
  if (!adminAuth.verified || !adminAuth.authenticatedServerBase) return false
  const normalized = normalizeServerUrl(base ?? activeBase())
  return Boolean(normalized) && normalized === adminAuth.authenticatedServerBase
}

/**
 * Electron main-process HTTP bridge, if the preload script exposed it.
 * @returns {{ request: (options: Object) => Promise<Object> } | null}
 */
function httpBridge() {
  try {
    if (typeof window !== 'undefined' && window.mpDesktop?.http?.request) {
      return window.mpDesktop.http
    }
  } catch {
    /* ignore inaccessible window */
  }
  return null
}

/**
 * Parse a bridge/fetch body into JSON when possible, keeping text otherwise.
 * @param {string} bodyText
 * @param {string} [contentType]
 * @returns {any}
 */
function parseBody(bodyText, contentType) {
  if (!bodyText) return ''
  const text = String(bodyText)
  if (String(contentType).includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return bodyText
    }
  }
  return bodyText
}

/**
 * Throw the normalized "server unreachable" error.
 * @returns {never}
 */
function throwNetworkError() {
  throw new Error(ADMIN_ERROR_NETWORK)
}

/**
 * Uppercase + validate an enum-ish value coming from UI code.
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} message
 * @returns {string}
 */
function requireChoice(value, allowed, message) {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!allowed.includes(normalized)) throw new Error(message)
  return normalized
}

/**
 * Plain-object guard for request bodies.
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

/**
 * Low-level authenticated admin request (internal; exported for smoke tests and
 * advanced callers). The URL is `${targetBase}${path}` where `targetBase` is the
 * explicit `options.base` or the current session base.
 *
 * Before sending a **stored** credential, the target base must equal the base that was
 * verified (`authenticatedServerBase`), otherwise the request is rejected locally and
 * the session is cleared — a server switch can never leak the old password (D-08).
 *
 * @param {'POST' | 'GET' | string} method
 * @param {string} path Absolute API path, e.g. `/api/admin/verify`.
 * @param {any} [body] JSON body; omit for a body-less request.
 * @param {{ adminPassword?: string, base?: string }} [options] Explicit password
 *   override (used by the verify call, which has no session yet). Defaults to
 *   `adminAuth.password`.
 * @returns {Promise<Record<string, any>>} Parsed server body.
 * @throws {Error} Normalized user-facing error (see module docs).
 */
export async function adminRequest(method, path, body, options = {}) {
  const verb = String(method || 'POST').toUpperCase()
  const hasBody = body !== undefined
  const usesStoredCredential = options.adminPassword === undefined
  const base = targetBase(options)
  if (usesStoredCredential) {
    if (!adminAuth.verified || !adminAuth.authenticatedServerBase) throw new Error(ADMIN_ERROR_NOT_VERIFIED)
    if (base !== adminAuth.authenticatedServerBase) {
      // Destination changed (A→B, or same host with a different path prefix): never
      // send the old password there. Drop the session and force re-authentication.
      adminLogout()
      throw new Error(ADMIN_ERROR_SERVER_CHANGED)
    }
  }
  const password = options.adminPassword ?? adminAuth.password ?? ''
  const url = `${base}${path}`
  const headers = {
    Accept: 'application/json',
    'X-Admin-Password': String(password)
  }
  if (hasBody) headers['Content-Type'] = 'application/json'
  const payloadText = hasBody ? JSON.stringify(body) : undefined
  const bridge = httpBridge()
  // Never follow redirects: a 30x could forward the sensitive header to another origin.
  const redirectMode = 'error'

  let status = 0
  let payload = ''

  if (bridge) {
    let response
    try {
      response = await bridge.request({
        url,
        method: verb,
        headers,
        body: payloadText,
        timeout: 12000,
        redirect: redirectMode,
        followRedirects: false
      })
    } catch {
      throwNetworkError()
    }
    if (!response || response.error || !Number(response.status)) {
      if (response && response.redirected) throw new Error(ADMIN_ERROR_REDIRECT)
      throwNetworkError()
    }
    if (response.redirected || (Number(response.status) >= 300 && Number(response.status) < 400)) {
      throw new Error(ADMIN_ERROR_REDIRECT)
    }
    status = Number(response.status)
    payload = parseBody(response.bodyText, response.contentType)
  } else {
    let response
    try {
      response = await fetch(url, {
        method: verb,
        headers,
        body: payloadText,
        redirect: redirectMode,
        signal: typeof AbortSignal !== 'undefined' ? AbortSignal.timeout(12000) : undefined
      })
    } catch {
      throwNetworkError()
    }
    if (response.redirected) throw new Error(ADMIN_ERROR_REDIRECT)
    status = Number(response.status) || 0
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let contentType = ''
    try {
      contentType = response.headers?.get?.('content-type') || ''
    } catch {
      contentType = ''
    }
    payload = parseBody(text, contentType)
  }

  if (typeof payload === 'string' && payload.trim().startsWith('<')) {
    throw new Error(ADMIN_ERROR_HTML)
  }
  if (status === 403) throw new Error(ADMIN_ERROR_PASSWORD)
  if (status < 200 || status >= 300) {
    const serverMessage =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.message : ''
    const message = typeof serverMessage === 'string' ? serverMessage.trim() : ''
    throw new Error(message || `请求失败（HTTP ${status}）`)
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
}

/**
 * Verify the admin password and open the in-memory admin session.
 * Resolves `true` on success (password kept in memory only, bound to the immutable
 * server base it was verified against), `false` on failure with the normalized reason
 * stored in `adminAuth.error`.
 *
 * @param {string} password
 * @param {string} [base] Target server base; defaults to the current session base
 *   (or the saved address when not joined).
 * @returns {Promise<boolean>}
 */
export async function verifyAdmin(password, base) {
  if (adminAuth.verifying) return false
  const candidate = String(password ?? '')
  if (!candidate) {
    adminAuth.error = '请输入管理员密码'
    return false
  }
  let target
  try {
    target = targetBase({ base })
  } catch (error) {
    adminAuth.error = String(error?.message || '服务器地址无效')
    return false
  }
  adminAuth.verifying = true
  adminAuth.error = ''
  try {
    await adminRequest('POST', '/api/admin/verify', { password: candidate }, { adminPassword: candidate, base: target })
    adminAuth.password = candidate
    adminAuth.verified = true
    adminAuth.authenticatedServerBase = target
    return true
  } catch (error) {
    adminAuth.password = ''
    adminAuth.verified = false
    adminAuth.authenticatedServerBase = ''
    adminAuth.error = String(error?.message || ADMIN_ERROR_NETWORK)
    return false
  } finally {
    adminAuth.verifying = false
  }
}

/**
 * Close the admin session and forget the password (memory only), including the server
 * binding. Called on leave / server switch / PASSWORD_CHANGED / auth failure.
 * @returns {void}
 */
export function adminLogout() {
  adminAuth.password = ''
  adminAuth.verified = false
  adminAuth.verifying = false
  adminAuth.error = ''
  adminAuth.authenticatedServerBase = ''
}

/**
 * Update one platform credential: `POST /api/admin/config/cookie`.
 * NetEase expects the full `music.163.com` cookie (must contain `MUSIC_U=...`);
 * Bilibili expects the full `bilibili.com` cookie (must contain `SESSDATA=...`;
 * `buvid3` strongly recommended to avoid search risk-control).
 *
 * @param {'netease' | 'bilibili'} platform
 * @param {string} value Cookie header value.
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function setPlatformCookie(platform, value) {
  // Platform ids are lowercase on the wire — unlike the uppercase enum-ish endpoints,
  // so they are normalized separately instead of through requireChoice().
  const normalized = String(platform ?? '')
    .trim()
    .toLowerCase()
  if (!ADMIN_PLATFORMS.includes(normalized)) throw new Error('不支持的音源')
  const cookie = String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
  if (!cookie) throw new Error('凭据不能为空')
  return adminRequest('POST', '/api/admin/config/cookie', { platform: normalized, value: cookie })
}

/**
 * Update system parameters: `POST /api/admin/config/update`.
 * The caller sends ONLY the fields it wants to change — the server applies non-null
 * fields and broadcasts a fresh `PlayerState` afterwards.
 *
 * Note the desktop field → API field mapping used by the UI:
 * `maxQueueSize → maxSize`, `maxHistorySize → historySize` (the server DTO uses the
 * shorter names while the broadcast config uses the longer ones).
 *
 * @param {Record<string, any>} patch
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function updateAdminConfig(patch) {
  const body = ensureObject(patch)
  if (!Object.keys(body).length) throw new Error('没有需要保存的配置改动')
  return adminRequest('POST', '/api/admin/config/update', body)
}

/**
 * Lock or unlock a control channel: `POST /api/admin/lock`.
 * @param {'PAUSE' | 'SKIP' | 'SHUFFLE' | 'ALL'} type
 * @param {boolean} locked
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function setLock(type, locked) {
  const normalized = requireChoice(type, LOCK_TYPES, '锁定类型仅支持 PAUSE/SKIP/SHUFFLE/ALL')
  return adminRequest('POST', '/api/admin/lock', { type: normalized, locked: Boolean(locked) })
}

/**
 * Force a player action: `POST /api/admin/player/action`.
 * @param {'PAUSE' | 'SKIP' | 'SHUFFLE' | 'TOGGLE_FAIR_SHUFFLE' | 'TOGGLE_ALLOW_OFFLINE'} action
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function playerAction(action) {
  const normalized = requireChoice(
    action,
    PLAYER_ACTIONS,
    '不支持的播放指令（可用：PAUSE/SKIP/SHUFFLE/TOGGLE_FAIR_SHUFFLE/TOGGLE_ALLOW_OFFLINE）'
  )
  return adminRequest('POST', '/api/admin/player/action', { action: normalized })
}

/**
 * Set/clear the room entry password: `POST /api/admin/room/password`.
 * An empty string makes the room public (matches the server behaviour).
 * @param {string} password
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function setRoomPassword(password) {
  return adminRequest('POST', '/api/admin/room/password', { password: String(password ?? '') })
}

/**
 * Clear server-side data: `POST /api/admin/room/clear`.
 * @param {'QUEUE' | 'CHAT' | 'OFFLINE'} target
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function clearAdminData(target) {
  const normalized = requireChoice(target, CLEAR_TARGETS, '清理目标仅支持 QUEUE/CHAT/OFFLINE')
  return adminRequest('POST', '/api/admin/room/clear', { target: normalized })
}

/**
 * Reset the whole player/system: `POST /api/admin/system/reset`.
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function resetSystem() {
  return adminRequest('POST', '/api/admin/system/reset', {})
}

/**
 * Start/stop the live stream sync service: `POST /api/admin/room/stream`.
 * @param {boolean} enabled
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function setStream(enabled) {
  return adminRequest('POST', '/api/admin/room/stream', { enabled: Boolean(enabled) })
}

/**
 * Update private radio / private DJ config: `POST /api/admin/private-dj`.
 * Passing `mode` switches the feature itself (OFF/FM/DJ); the server rejects FM/DJ
 * when the NetEase cookie is not configured (400 with a Chinese message).
 *
 * @param {{ mode?: 'OFF' | 'FM' | 'DJ', fillBlankEnabled?: boolean, joinQueueEnabled?: boolean, custodyEnabled?: boolean }} patch
 * @returns {Promise<Record<string, any>>} `{ message }`
 */
export async function updatePrivateDj(patch) {
  const body = ensureObject(patch)
  const keys = Object.keys(body)
  if (!keys.length) throw new Error('没有需要更新的私人电台配置')
  const allowed = ['mode', 'fillBlankEnabled', 'joinQueueEnabled', 'custodyEnabled']
  for (const key of keys) {
    if (!allowed.includes(key)) throw new Error(`不支持的私人电台字段：${key}`)
  }
  if (body.mode !== undefined) {
    body.mode = requireChoice(body.mode, PRIVATE_DJ_MODES, '私人电台模式仅支持 OFF/FM/DJ')
  }
  return adminRequest('POST', '/api/admin/private-dj', body)
}

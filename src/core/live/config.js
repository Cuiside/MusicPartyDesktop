/**
 * Live-connection settings and endpoint helpers for the MusicParty desktop client.
 *
 * Settings are persisted in `localStorage` under `mp.desktop.settings`:
 * `{ serverUrl, mode: 'local' | 'remote', userName }`.
 * In a non-browser runtime (Node tests) an in-memory fallback is used so the same
 * module works without `localStorage`.
 *
 * Two different concepts are deliberately kept apart:
 * - the **saved / next connection** address (`loadSettings().serverUrl`);
 * - the **current session base** (`session.js`), frozen when a room is joined and used
 *   for every HTTP / WebSocket / media / admin request until the session ends.
 * `httpBase()` is only the low-level fallback used before a session exists.
 *
 * Address normalization (D-02/D-12):
 * - explicit `http://` / `https://` / `ws://` / `wss://` is respected (`ws(s)` is
 *   mapped to `http(s)` for REST and re-derived for the WebSocket);
 * - a bare host defaults to `https://` for public domains and to `http://` for
 *   loopback / private-network hosts;
 * - the full path prefix is preserved (reverse-proxy deployments) and a trailing
 *   `/ws` segment is stripped so `wsUrl()` can append it exactly once;
 * - invalid input never silently falls back to localhost: {@link parseServerUrl}
 *   returns a readable error and {@link normalizeServerUrl} returns an empty string.
 *
 * @module core/live/config
 */

/** Default MusicParty backend origin (local development service). */
export const DEFAULT_SERVER = 'http://127.0.0.1:8080'

/** localStorage key holding the desktop settings object. */
export const SETTINGS_KEY = 'mp.desktop.settings'

/** @type {Map<string, string>} in-memory fallback when localStorage is unavailable */
const memoryStore = new Map()

/** Hosts that always mean "this machine" and therefore keep plain HTTP. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** RFC1918 private IPv4 ranges: these stay on plain HTTP too. */
const PRIVATE_IPV4 = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/

/** Matches an explicit URL scheme at the start of the input. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i

/** Protocol-relative input such as `//host/path`. */
const PROTOCOL_RELATIVE_RE = /^\/\//

/**
 * Best-effort localStorage accessor (may be unavailable in Node / sandboxed frames).
 * @returns {Storage | null}
 */
function storage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage
  } catch {
    /* access can throw in privacy modes */
  }
  return null
}

/**
 * Is this hostname loopback or on a private LAN?
 *
 * Loopback / private hosts keep plain `http://` when the user types a bare address
 * (the local Java service has no TLS), while public domains default to `https://`.
 *
 * @param {string} host Hostname (no port), e.g. `127.0.0.1` or `music.example.com`.
 * @returns {boolean}
 */
export function isPrivateOrLoopbackHost(host) {
  const value = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!value) return false
  if (LOOPBACK_HOSTS.has(value)) return true
  if (value.endsWith('.localhost')) return true
  if (value.includes(':')) {
    // IPv6 loopback written as `::1` (already covered) or an IPv6 ULA/private range.
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')
  }
  return PRIVATE_IPV4.test(value)
}

/**
 * Parse + normalize a user-supplied server address.
 *
 * Accepts `127.0.0.1:8080`, `localhost:8080/prefix`, `http://host:8080/`,
 * `ws://host/ws`, `wss://host/prefix`, bare public domains (→ HTTPS) and full
 * invite links (query/hash are ignored for the base).
 *
 * @param {unknown} value Raw address from settings, an invite link or the UI.
 * @returns {{ ok: true, url: string, scheme: string, host: string, pathPrefix: string, secure: boolean }
 *   | { ok: false, error: string }}
 */
export function parseServerUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return { ok: false, error: '请填写服务器地址（示例：127.0.0.1:8080 或 https://your-server.example.com）' }
  }
  if (/\s/.test(raw)) {
    return { ok: false, error: '服务器地址不能包含空格，请检查是否粘贴完整' }
  }
  const schemeMatch = raw.match(SCHEME_RE)
  const explicitScheme = schemeMatch ? schemeMatch[1].toLowerCase() : ''
  if (explicitScheme && !['http', 'https', 'ws', 'wss'].includes(explicitScheme)) {
    return { ok: false, error: `只支持 http:// 或 https:// 开头的服务器地址（当前是 ${explicitScheme}://）` }
  }
  let candidate = raw
  if (PROTOCOL_RELATIVE_RE.test(candidate)) candidate = `https:${candidate}`
  else if (!explicitScheme) candidate = `https://${candidate}`

  let url
  try {
    url = new URL(candidate)
  } catch {
    return {
      ok: false,
      error: '地址格式不正确：示例 http://127.0.0.1:8080 或 https://your-server.example.com（可带路径前缀）'
    }
  }
  if (url.username || url.password) {
    return { ok: false, error: '服务器地址不能包含用户名或密码，请只填写地址与端口' }
  }
  if (!url.hostname) {
    return { ok: false, error: '地址缺少主机名，请检查后重试（示例：http://127.0.0.1:8080）' }
  }

  // ws(s) → http(s) for the REST/base pair; the WebSocket URL is re-derived by wsUrl().
  let scheme = url.protocol.replace(':', '').toLowerCase()
  if (scheme === 'ws') scheme = 'http'
  else if (scheme === 'wss') scheme = 'https'
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, error: '只支持 http:// 或 https:// 开头的服务器地址' }
  }
  if (!explicitScheme) {
    // Bare address: public domains need TLS; loopback/LAN keeps plain HTTP.
    scheme = isPrivateOrLoopbackHost(url.hostname) ? 'http' : 'https'
  }

  let path = url.pathname || ''
  path = path.replace(/\/+$/, '')
  // Reverse proxies may expose the STOMP endpoint at `<prefix>/ws`; strip exactly
  // one trailing `/ws` so wsUrl() re-appends it without duplicating the segment.
  if (/\/ws$/i.test(path)) path = path.slice(0, -3).replace(/\/+$/, '')
  // Collapse duplicated inner slashes such as `//prefix` (the scheme separator is
  // re-added below, so this cannot touch the `https://` part).
  path = path.replace(/\/{2,}/g, '/')
  if (path === '/') path = ''
  return {
    ok: true,
    url: `${scheme}://${url.host}${path}`,
    scheme,
    host: url.host,
    pathPrefix: path,
    secure: scheme === 'https'
  }
}

/**
 * Normalize a user-supplied server address to an absolute `http(s)` base URL
 * (scheme + host + optional path prefix, no trailing slash).
 *
 * Invalid input yields an empty string — callers that need a reason must use
 * {@link parseServerUrl}. This function never falls back to `DEFAULT_SERVER`.
 *
 * @param {string} [value] Raw address from settings or the UI.
 * @returns {string} Normalized base URL, e.g. `http://127.0.0.1:8080`, or `''`.
 */
export function normalizeServerUrl(value) {
  const parsed = parseServerUrl(value)
  return parsed.ok ? parsed.url : ''
}

/**
 * Read persisted settings, merged over defaults. Never throws.
 *
 * A corrupted persisted address is reported with a console warning and replaced by
 * {@link DEFAULT_SERVER} (the UI must validate new input explicitly instead).
 *
 * @returns {{ serverUrl: string, mode: 'local' | 'remote', userName: string }}
 */
export function loadSettings() {
  const store = storage()
  let raw = null
  try {
    raw = store ? store.getItem(SETTINGS_KEY) : memoryStore.get(SETTINGS_KEY)
  } catch {
    raw = null
  }
  let parsed = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw) || {}
    } catch {
      parsed = {}
    }
  }
  const rawServer = typeof parsed.serverUrl === 'string' ? parsed.serverUrl : ''
  let serverUrl = DEFAULT_SERVER
  if (rawServer) {
    const normalized = normalizeServerUrl(rawServer)
    if (normalized) serverUrl = normalized
    else console.warn('[live] 已保存的服务器地址无法识别，已回退为默认本机地址：', rawServer)
  }
  return {
    serverUrl,
    mode: parsed.mode === 'remote' ? 'remote' : 'local',
    userName: typeof parsed.userName === 'string' ? parsed.userName : ''
  }
}

/**
 * Merge a partial settings patch into the persisted settings and return the new object.
 *
 * Invalid `serverUrl` values are ignored with a warning (the UI validates through
 * {@link parseServerUrl} before saving); the previously saved address is kept.
 * The `userName` is trimmed and capped at 32 characters. The room password is
 * intentionally NOT stored here (it is only kept by the caller for the current session).
 *
 * @param {Partial<{ serverUrl: string, mode: 'local' | 'remote', userName: string }>} [partial]
 * @returns {{ serverUrl: string, mode: 'local' | 'remote', userName: string }}
 */
export function saveSettings(partial = {}) {
  const current = loadSettings()
  let serverUrl = current.serverUrl
  if (partial.serverUrl !== undefined) {
    const raw = String(partial.serverUrl ?? '').trim()
    const normalized = normalizeServerUrl(raw)
    if (normalized) serverUrl = normalized
    else if (raw) console.warn('[live] 拒绝保存无法识别的服务器地址：', raw)
  }
  const next = {
    serverUrl,
    mode: (partial.mode ?? current.mode) === 'remote' ? 'remote' : 'local',
    userName: String(partial.userName ?? current.userName).trim().slice(0, 32)
  }
  const encoded = JSON.stringify(next)
  const store = storage()
  try {
    if (store) store.setItem(SETTINGS_KEY, encoded)
  } catch {
    /* quota / privacy mode: keep the in-memory copy */
  }
  memoryStore.set(SETTINGS_KEY, encoded)
  return next
}

/**
 * Absolute HTTP base for REST calls (`/api/...`), without a trailing slash.
 *
 * This is the **fallback** used before a session exists; live sessions must use the
 * frozen session base from `session.js`.
 *
 * @param {string} [serverUrl] Optional override; falls back to the saved setting.
 * @returns {string} e.g. `http://127.0.0.1:8080`.
 */
export function httpBase(serverUrl) {
  if (serverUrl) {
    const normalized = normalizeServerUrl(serverUrl)
    if (normalized) return normalized
  }
  return loadSettings().serverUrl || DEFAULT_SERVER
}

/**
 * STOMP-over-WebSocket endpoint derived from an HTTP base: `http(s)` → `ws(s)` + `/ws`.
 *
 * This is a bare WebSocket endpoint (no SockJS), matching the server's
 * `registry.addEndpoint("/ws")` registration. A path prefix is preserved, so
 * `https://host/prefix` becomes `wss://host/prefix/ws`.
 *
 * @param {string} [serverUrl] Optional override; falls back to the saved setting.
 * @returns {string} e.g. `ws://127.0.0.1:8080/ws`.
 */
export function wsUrl(serverUrl) {
  const base = httpBase(serverUrl)
  try {
    const url = new URL(base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let path = url.pathname.replace(/\/+$/, '')
    if (!/\/ws$/i.test(path)) path = `${path}/ws`
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return 'ws://127.0.0.1:8080/ws'
  }
}

/**
 * Host (with port, no scheme) suitable for compact UI labels such as `127.0.0.1:8080`.
 *
 * This is a **display** value only — never reconstruct URLs from it (use the session
 * base instead, see D-12).
 *
 * @param {string} [serverUrl] Optional override; falls back to the saved setting.
 * @returns {string}
 */
export function serverHost(serverUrl) {
  try {
    return new URL(httpBase(serverUrl)).host
  } catch {
    return '127.0.0.1:8080'
  }
}

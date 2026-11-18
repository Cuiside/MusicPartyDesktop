'use strict'

/**
 * 渲染层 → 主进程 HTTP 桥（`mp:http:request`）。
 *
 * 为什么存在：MusicParty 后端的 REST 端点没有 CORS 配置，而渲染层运行在 file:// 或
 * Vite dev server 下，浏览器 fetch 会被同源策略拦截；主进程代发即可工作。
 *
 * 安全语义（D-08/D-03/D-05 相关）：
 *  - 只允许 http/https；
 *  - **不跟随重定向**（fetch redirect:'manual'）：3xx 一律返回失败，附 location 与
 *    crossOrigin 标记。渲染层传 `redirect:'error'`（或任何值）都是这个语义，
 *    避免自定义敏感头（X-Admin-Password / X-Room-Token）随跳转泄漏；
 *  - 校验调用方 frame：仅接受 file:// 应用的页面或 dev server
 *    http://127.0.0.1:5173 / http://localhost:5173；其它来源返回 untrusted-origin；
 *  - 任何异常都返回结构化对象，不向渲染层抛异常；
 *  - 未知字段忽略（兼容旧调用方）。
 *
 * 不 require('electron')：fetch / 信任判定可注入，纯 Node 可测。
 */

const DEFAULT_TIMEOUT_MS = 10000
const MAX_TIMEOUT_MS = 60000
const MIN_TIMEOUT_MS = 500

/** dev server 允许的来源（严格匹配 host+port）。 */
const DEV_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])

/** 判断 IPC 调用方 frame 是否可信（file:// 应用页或 dev server）。 */
function isTrustedRendererFrame(frame) {
  let url = ''
  try {
    if (frame && typeof frame.url === 'string') url = frame.url
  } catch (_) {
    return false
  }
  if (!url) return false
  if (/^file:\/\//i.test(url)) return true
  try {
    const parsed = new URL(url)
    return DEV_ORIGINS.has(parsed.origin)
  } catch (_) {
    return false
  }
}

function normalizeMethod(raw) {
  const method = String(raw || 'GET').trim().toUpperCase()
  return /^[A-Z]{3,10}$/.test(method) ? method : 'GET'
}

function normalizeHeaders(raw) {
  const headers = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return headers
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') headers[key] = String(value)
  }
  return headers
}

function clampTimeout(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(number)))
}

/**
 * 创建 `mp:http:request` handler。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(frame: any) => boolean} [options.isTrustedFrame] 可注入（测试用）
 * @returns {(event: any, options?: object) => Promise<object>}
 */
function createHttpBridgeHandler(options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const isTrustedFrame =
    typeof options.isTrustedFrame === 'function' ? options.isTrustedFrame : isTrustedRendererFrame

  return async function handleHttpRequest(event, requestOptions = {}) {
    const source = requestOptions && typeof requestOptions === 'object' ? requestOptions : {}
    const frame = event && event.senderFrame ? event.senderFrame : null
    if (!isTrustedFrame(frame)) {
      return {
        ok: false,
        status: 0,
        error: 'untrusted-origin',
        detail: '只允许桌面应用页面（file://）或本地 dev server（127.0.0.1:5173）发起 HTTP 桥请求'
      }
    }
    if (!fetchImpl) {
      return { ok: false, status: 0, error: 'fetch-unavailable', detail: '当前主进程运行时不支持 fetch' }
    }

    const rawUrl = String(source.url || '')
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch (_) {
      return { ok: false, status: 0, error: 'invalid url' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, status: 0, error: 'invalid url', detail: '仅支持 http/https' }
    }

    const method = normalizeMethod(source.method)
    const headers = normalizeHeaders(source.headers)
    const timeoutMs = clampTimeout(source.timeout)

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => {
      try {
        if (controller) controller.abort()
      } catch (_) {
        /* ignore */
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    const init = {
      method,
      headers,
      // 安全关键：绝不自动跟随重定向。
      redirect: 'manual',
      signal: controller ? controller.signal : undefined
    }
    if (method !== 'GET' && method !== 'HEAD' && source.body != null) {
      init.body = source.body
    }

    try {
      const response = await fetchImpl(parsed.toString(), init)
      const status = Number(response.status) || 0
      const location = (response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('location')
        : '') || ''

      if (status >= 300 && status < 400) {
        let crossOrigin = false
        let resolved = ''
        try {
          resolved = new URL(location, parsed).toString()
          crossOrigin = new URL(resolved).origin !== parsed.origin
        } catch (_) {
          crossOrigin = true
        }
        // `redirect: 'error'` 的语义：禁止跟随并明确报错（不返回 ok:true）。
        return {
          ok: false,
          status,
          bodyText: '',
          contentType: '',
          redirected: true,
          redirectBlocked: true,
          location: resolved || location,
          crossOrigin,
          error: 'redirect-blocked',
          detail: `服务返回重定向（HTTP ${status}${resolved ? ` → ${resolved.slice(0, 200)}` : ''}），已按安全策略拒绝跟随${crossOrigin ? '（跨源）' : ''}`
        }
      }

      let bodyText = ''
      try {
        bodyText = await response.text()
      } catch (_) {
        bodyText = ''
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        bodyText,
        contentType: (response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('content-type')
          : '') || '',
        finalUrl: (response.url && String(response.url)) || parsed.toString(),
        redirected: false
      }
    } catch (error) {
      const aborted = error && error.name === 'AbortError'
      return {
        ok: false,
        status: 0,
        error: aborted ? 'timeout' : 'network-error',
        detail: aborted
          ? `请求超时（>${Math.round(timeoutMs / 1000)}s）`
          : String((error && error.message) || error).slice(0, 300)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  DEV_ORIGINS,
  isTrustedRendererFrame,
  createHttpBridgeHandler,
  normalizeHeaders,
  clampTimeout
}

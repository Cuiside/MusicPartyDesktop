'use strict'

/**
 * 服务健康探测（D-04/D-03）。
 *
 * 三类状态必须分开：
 *   1. Java 进程存活（launcher.cjs 管理）——「进程活着」不等于「服务可用」；
 *   2. MusicParty ready —— `GET <base>/api/config` 必须 2xx + JSON + 含预期字段；
 *      4xx/5xx/HTML/超时/重定向 都不算 ready（审计实测 404 也被旧代码当健康）；
 *   3. 网易云 API ready —— `GET <neteaseApiBaseUrl>/inner/version`（2xx+JSON；旧版
 *      API 无该端点时回退探测 `/`），4xx/5xx/HTML 不算健康。
 *
 * 此外提供只用于日志/诊断的脱敏工具：任何秘密值（管理员密码/Cookie 等）在进入
 * 日志、错误文案、诊断导出之前都会被替换为 ***。
 *
 * 本模块不 require('electron')；fetch 可注入，便于纯 Node 合成 HTTP mock 测试。
 */

const DEFAULT_TIMEOUT_MS = 2500

/** MusicParty /api/config 的“预期字段”白名单（至少命中一个才算真正的 MusicParty）。 */
const MUSIC_PARTY_CONFIG_FIELDS = [
  'backWords',
  'authorName',
  'hasProtection',
  'isSetup',
  'capabilities',
  'serverVersion',
  'restProtectionEnabled',
  'adminConfigured'
]

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeMusicPartyConfig(json) {
  if (!isPlainObject(json)) return false
  if (Array.isArray(json.capabilities)) return true
  for (const field of ['backWords', 'authorName', 'serverVersion']) {
    if (typeof json[field] === 'string' && json[field].trim() !== '') return true
  }
  for (const field of ['hasProtection', 'isSetup', 'restProtectionEnabled', 'adminConfigured']) {
    if (typeof json[field] === 'boolean') return true
  }
  return false
}

function normalizeBaseUrl(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  return text.replace(/\/+$/, '')
}

function parseJsonSafe(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (_) {
    return { ok: false, value: null }
  }
}

function isJsonContentType(contentType) {
  return /^application\/(?:[\w.+-]*\+)?json\b/i.test(String(contentType || '').trim())
}

/**
 * 带超时的 GET（默认不跟随重定向：3xx 视为失败，避免错误服务/门户页伪装健康）。
 *
 * @returns {Promise<{ok: boolean, status: number, json: any, text: string, contentType: string,
 *   error: string|null, redirected: boolean, location: string, timeout: boolean}>}
 */
async function httpProbe(url, options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const result = {
    ok: false,
    status: 0,
    json: null,
    text: '',
    contentType: '',
    error: null,
    redirected: false,
    location: '',
    timeout: false
  }
  if (!fetchImpl) {
    result.error = '当前 Node 运行时不支持 fetch，无法进行健康探测'
    return result
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : setTimeout(() => {
        /* 无 AbortController 时仅靠 Promise.race 计时 */
      }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined
    })
    result.status = Number(response.status) || 0
    result.contentType = (response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-type')
      : '') || ''
    result.location = (response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('location')
      : '') || ''
    if (result.status >= 300 && result.status < 400) {
      result.redirected = true
      result.error = `服务返回重定向（HTTP ${result.status}${result.location ? ` → ${String(result.location).slice(0, 120)}` : ''}），不作为健康`
      return result
    }
    let text = ''
    try {
      text = await response.text()
    } catch (_) {
      text = ''
    }
    result.text = text
    const parsed = parseJsonSafe(text)
    result.json = parsed.ok ? parsed.value : null
    if (!isJsonContentType(result.contentType) && !parsed.ok) {
      result.error = `响应不是 JSON（content-type=${result.contentType || '空'}）`
      return result
    }
    if (result.status < 200 || result.status >= 300) {
      result.error = `HTTP ${result.status}（健康检查要求 2xx）`
      return result
    }
    result.ok = true
    return result
  } catch (error) {
    const name = error && error.name
    if (name === 'AbortError') {
      result.timeout = true
      result.error = `健康检查超时（>${Math.round(timeoutMs / 1000)}s）`
    } else {
      result.error = `无法连接：${String((error && error.message) || error).slice(0, 200)}`
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** MusicParty ready 探测：/api/config 2xx + JSON + 预期字段。 */
async function probeMusicParty(baseUrl, options = {}) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return { ok: false, url: '', status: 0, error: '未配置服务地址', json: null, server: null }
  const url = `${base}/api/config`
  const response = await httpProbe(url, options)
  if (!response.ok) {
    return { ok: false, url, status: response.status, error: response.error, json: response.json, server: null }
  }
  if (!looksLikeMusicPartyConfig(response.json)) {
    return {
      ok: false,
      url,
      status: response.status,
      error: '响应 JSON 不是 MusicParty /api/config（缺少预期字段：backWords/authorName/capabilities/serverVersion 等）',
      json: response.json,
      server: null
    }
  }
  const json = response.json
  const server = {
    version: typeof json.serverVersion === 'string' ? json.serverVersion : '',
    capabilities: Array.isArray(json.capabilities) ? json.capabilities.slice() : [],
    adminConfigured: typeof json.adminConfigured === 'boolean' ? json.adminConfigured : null,
    restProtectionEnabled:
      typeof json.restProtectionEnabled === 'boolean' ? json.restProtectionEnabled : null,
    cookieSource: typeof json.cookieSource === 'string' ? json.cookieSource : ''
  }
  return { ok: true, url, status: response.status, error: null, json, server }
}

/**
 * 网易云 API 健康探测：
 *   1) GET <base>/inner/version，2xx+JSON 即健康（NetEaseCloudMusicApi 老版本对
 *      /inner/version 返回 404，因此允许回退）；
 *   2) 回退 GET <base>/，2xx+JSON 即健康。
 * 4xx/5xx/HTML/超时/重定向都不健康。
 */
async function probeNeteaseApi(baseUrl, options = {}) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return { ok: false, url: '', status: 0, error: '未配置网易云 API 地址', version: null }
  const first = await httpProbe(`${base}/inner/version`, options)
  if (first.ok) {
    return {
      ok: true,
      url: `${base}/inner/version`,
      status: first.status,
      error: null,
      version: extractNeteaseVersion(first.json)
    }
  }
  const fallback = await httpProbe(`${base}/`, options)
  if (fallback.ok) {
    return {
      ok: true,
      url: `${base}/`,
      status: fallback.status,
      error: null,
      version: extractNeteaseVersion(fallback.json),
      fallback: true
    }
  }
  // 优先报告 /inner/version 的失败原因（更具体），但也附上根路径结论。
  const reason =
    first.status === 404
      ? `网易云 API 未就绪：/inner/version 返回 404，根路径 ${fallback.status ? `返回 HTTP ${fallback.status}` : fallback.error || '不可用'}`
      : first.error || fallback.error || '网易云 API 不可用'
  return { ok: false, url: `${base}/inner/version`, status: first.status || fallback.status, error: reason, version: null }
}

function extractNeteaseVersion(json) {
  if (!isPlainObject(json)) return null
  for (const key of ['version', 'data', 'body']) {
    const value = json[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (isPlainObject(value)) {
      const nested = extractNeteaseVersion(value)
      if (nested) return nested
    }
  }
  return null
}

/**
 * 敏感值脱敏：把 secrets 中的每个非空值替换为 ***（含 URL 编码形式）。
 * 只替换长度 >= 4 的值，避免把 "1"/"true" 等常用词误伤。
 *
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function redactSecrets(text, secrets) {
  let out = String(text == null ? '' : text)
  const values = (Array.isArray(secrets) ? secrets : [])
    .filter((value) => typeof value === 'string' && value.length >= 4)
    .sort((a, b) => b.length - a.length)
  for (const value of values) {
    out = out.split(value).join('***')
    try {
      const encoded = encodeURIComponent(value)
      if (encoded !== value && encoded.length >= 4) out = out.split(encoded).join('***')
    } catch (_) {
      /* ignore */
    }
    try {
      const encodedPlus = encodeURIComponent(value).replace(/%20/g, '+')
      if (encodedPlus !== value && encodedPlus.length >= 4) out = out.split(encodedPlus).join('***')
    } catch (_) {
      /* ignore */
    }
  }
  return out
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MUSIC_PARTY_CONFIG_FIELDS,
  normalizeBaseUrl,
  looksLikeMusicPartyConfig,
  isJsonContentType,
  httpProbe,
  probeMusicParty,
  probeNeteaseApi,
  redactSecrets
}

/**
 * MusicParty 桌面端启动器 · 渲染层桥（ESM）。
 *
 * 数据源是 preload 暴露的 `window.mpDesktop.launcher`（契约见 docs/LAUNCHER.md）：
 *   getConfig() / setConfig(patch) / start() / stop() / restart() / status()
 *   / openDataDir() / pickFile(kind) / onLog(cb) / onStatus(cb)
 *   / setSecrets(patch) / clearSecrets(options) / ensureLocalAdminPassword()
 *   / revealLocalAdminPassword()
 *
 * 秘密（D-03）：getConfig() 返回的配置里没有 adminPassword / neteaseCookie /
 * biliCookie 明文，只有 `adminPasswordSet / neteaseCookieSet / biliCookieSet` 布尔与
 * `secretsStorage` 能力描述。真正的写入走 setSecrets()。
 *
 * 非 Electron 环境（纯浏览器 / 构建预览）里：
 *  - 所有 IPC 调用降级为 no-op：getConfig 返回本地默认配置，start/stop/restart 返回 false
 *    并把原因写进 launcher.error，日志仍写进 launcher.logs（本地数组，便于设置页落档演示）。
 *
 * 状态（D-04）三态分离：
 *  - `services.java` 进程存活 + `state`（missing/probing/incompatible/starting/ready/
 *    degraded/error/stopped）；
 *  - `services.netease` 网易云 API 独立健康（缺失只是音源降级，不代表 Java 失败）；
 *  - `services.system` 汇总（ok/degraded/error/stopped）。
 *  `resources` 同时提供嵌套结构（java / serverJar / neteaseApi）与旧扁平字段。
 */

import { reactive } from 'vue'

const LOG_LIMIT = 500

/**
 * 浏览器演示用的默认配置（非秘密字段）。必须与 electron/launcher.cjs 的
 * DEFAULT_CONFIG 保持一致（主进程可用时以主进程返回的配置为准）。
 */
const DEFAULT_CONFIG = Object.freeze({
  // 服务
  serverIp: '127.0.0.1',
  serverPort: '8080',
  baseUrl: 'http://localhost:8080',
  // 应用
  authorName: 'ThorNex',
  backWords: 'THORNEX',
  // 网易云
  neteaseQuality: 'exhigh',
  neteaseEnabled: true,
  neteaseApiBaseUrl: 'http://127.0.0.1:3000',
  // B 站
  bilibiliEnabled: true,
  // 队列
  queueMaxSize: 1000,
  queueHistorySize: 50,
  queueMaxUserSongs: 100,
  // 播放器
  maxPlaylistImportSize: 100,
  // 聊天
  chatMaxHistorySize: 1000,
  chatMinIntervalMs: 1000,
  chatMaxMessageLength: 200,
  // 缓存
  cacheMaxSize: '1GB',
  // 认证限流
  authRateLimitEnabled: true,
  authMaxAttempts: 5,
  authWindowSeconds: 60,
  authBlockDuration: 300,
  // 启动器扩展
  autoStart: false,
  javaPath: '',
  serverJar: '',
  neteaseApiPath: ''
})

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))
const SECRET_FLAG_KEYS = ['adminPasswordSet', 'neteaseCookieSet', 'biliCookieSet']

function emptyService(extra = {}) {
  return {
    state: 'stopped',
    running: false,
    pid: null,
    uptimeMs: 0,
    healthy: false,
    version: '',
    compatible: null,
    lastError: null,
    ...extra
  }
}

/** 与主进程 probeResources() 形状一致；未知时按“缺失”处理（不误显示为可启动）。 */
function emptyResources() {
  return {
    java: { found: false, path: '', version: '', compatible: null, source: 'none', lastError: null },
    serverJar: { found: false, path: '', source: 'none', version: '' },
    neteaseApi: { found: false, path: '', source: 'none', version: '', baseUrl: '', mode: 'disabled' },
    javaPath: '',
    javaFound: false,
    javaSource: 'none',
    jarPath: '',
    jarFound: false,
    jarSource: 'none',
    neteasePath: '',
    neteaseFound: false,
    neteaseSource: 'none',
    bundled: false,
    binDir: '',
    ready: false,
    missing: ['java', 'jar'],
    source: 'none',
    packaged: false
  }
}

function emptyStatus() {
  return {
    running: false,
    healthy: false,
    degraded: false,
    needsAdminPassword: true,
    baseUrl: '',
    services: {
      java: emptyService(),
      netease: emptyService({ baseUrl: '', mode: 'disabled' }),
      system: { state: 'stopped', lastError: null }
    },
    server: null,
    resources: emptyResources(),
    warnings: [],
    secretsStorage: { mode: 'unknown', encrypted: false, warning: null },
    lastError: null,
    logTail: [],
    healthUrl: '',
    dataDir: '',
    configPath: '',
    logCount: 0,
    updatedAt: 0
  }
}

function copyConfig(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const out = { ...DEFAULT_CONFIG }
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key]
  }
  for (const key of SECRET_FLAG_KEYS) {
    out[key] = source[key] === true
  }
  if (source.secretsStorage && typeof source.secretsStorage === 'object') {
    out.secretsStorage = { ...source.secretsStorage }
  }
  if (typeof source.neteaseApiBaseUrlEffective === 'string') {
    out.neteaseApiBaseUrlEffective = source.neteaseApiBaseUrlEffective
  }
  return out
}

function getBridge() {
  if (typeof window === 'undefined') return null
  const desktop = window.mpDesktop
  const bridge = desktop && desktop.launcher
  return bridge && typeof bridge === 'object' ? bridge : null
}

function hasBridgeMethod(method) {
  const bridge = getBridge()
  return Boolean(bridge && typeof bridge[method] === 'function')
}

function toMessage(error) {
  if (!error) return '未知错误'
  return String(error.message || error)
}

/* ------------------------------------------------------------------ */
/* 响应式状态                                                          */
/* ------------------------------------------------------------------ */

export const launcher = reactive({
  /** 是否检测到 preload 暴露的 window.mpDesktop.launcher */
  available: Boolean(getBridge()),
  /** 当前启动器配置（脱敏：秘密只有 *Set 布尔） */
  config: copyConfig(null),
  /** 主进程状态快照（running/services/lastError...） */
  status: emptyStatus(),
  /** 最近日志（最大 500 行） { service, line, time } */
  logs: [],
  /** 最近一次操作失败原因（成功操作会清空） */
  error: '',
  /** start/stop/restart 是否进行中 */
  busy: false
})

/* ------------------------------------------------------------------ */
/* 日志 / 状态订阅                                                     */
/* ------------------------------------------------------------------ */

const logListeners = new Set()
const statusListeners = new Set()
let subscribed = false

function normalizeLog(entry) {
  if (!entry || typeof entry !== 'object') return null
  const service = entry.service === 'java' || entry.service === 'netease' ? entry.service : 'system'
  const line = String(entry.line == null ? '' : entry.line)
  if (!line) return null
  return {
    service,
    line,
    time: typeof entry.time === 'string' && entry.time ? entry.time : new Date().toISOString()
  }
}

function appendLog(entry) {
  const normalized = normalizeLog(entry)
  if (!normalized) return null
  launcher.logs.push(normalized)
  if (launcher.logs.length > LOG_LIMIT) {
    launcher.logs.splice(0, launcher.logs.length - LOG_LIMIT)
  }
  for (const listener of logListeners) {
    try {
      listener(normalized)
    } catch (_) {
      /* 单个监听器出错不影响其他订阅者 */
    }
  }
  return normalized
}

function applyStatus(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return launcher.status
  const services = snapshot.services && typeof snapshot.services === 'object' ? snapshot.services : {}
  const resources = snapshot.resources && typeof snapshot.resources === 'object' ? snapshot.resources : null
  const logTail = Array.isArray(snapshot.logTail) ? snapshot.logTail.filter(Boolean).slice(-3) : []
  const previous = launcher.status
  const next = {
    ...previous,
    ...snapshot,
    services: {
      java: { ...previous.services.java, ...(services.java || {}) },
      netease: { ...previous.services.netease, ...(services.netease || {}) },
      system: { ...previous.services.system, ...(services.system || {}) }
    },
    logTail
  }
  if (resources) {
    next.resources = { ...emptyResources(), ...resources }
    for (const nested of ['java', 'serverJar', 'neteaseApi']) {
      if (resources[nested] && typeof resources[nested] === 'object') {
        next.resources[nested] = { ...emptyResources()[nested], ...resources[nested] }
      }
    }
    if (!Array.isArray(next.resources.missing)) next.resources.missing = []
  }
  launcher.status = next
  for (const listener of statusListeners) {
    try {
      listener(launcher.status)
    } catch (_) {
      /* ignore */
    }
  }
  return launcher.status
}

function subscribeBridge() {
  if (subscribed) return
  const bridge = getBridge()
  if (!bridge) return
  subscribed = true
  if (typeof bridge.onLog === 'function') {
    try {
      bridge.onLog((entry) => appendLog(entry))
    } catch (_) {
      /* ignore */
    }
  }
  if (typeof bridge.onStatus === 'function') {
    try {
      bridge.onStatus((snapshot) => applyStatus(snapshot))
    } catch (_) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function setError(message) {
  launcher.error = message || ''
}

/** 本地失败（非 Electron / 桥异常）：写 error 并往本地日志数组补一条 system 错误。 */
function failLocal(message) {
  setError(message)
  appendLog({ service: 'system', line: `[ERROR] ${message}` })
  return false
}

function asConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return copyConfig(value)
}

function mergeLocalConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return launcher.config
  launcher.config = copyConfig({ ...launcher.config, ...patch })
  return launcher.config
}

function applyActionResult(result) {
  if (result && result.status) applyStatus(result.status)
  if (result && result.ok === false) {
    setError(result.error || '启动器操作失败')
    if (result.needsAdminPassword === true) {
      launcher.status = { ...launcher.status, needsAdminPassword: true }
    }
    return false
  }
  setError('')
  return Boolean(result && result.ok)
}

/* ------------------------------------------------------------------ */
/* 对外方法                                                            */
/* ------------------------------------------------------------------ */

/** 读取配置（脱敏）；非 Electron 下返回本地默认配置。 */
export async function getConfig() {
  const bridge = getBridge()
  if (!bridge || typeof bridge.getConfig !== 'function') {
    launcher.config = copyConfig(launcher.config)
    setError('')
    return launcher.config
  }
  try {
    const raw = await bridge.getConfig()
    const config = asConfig(raw)
    if (config) {
      launcher.config = config
      setError('')
    } else {
      setError('读取启动器配置失败')
    }
  } catch (error) {
    setError(`读取启动器配置失败：${toMessage(error)}`)
  }
  return launcher.config
}

/** 合并保存非秘密配置（只提交 patch 中的字段）；秘密字段请用 setSecrets。 */
export async function setConfig(patch) {
  const bridge = getBridge()
  if (!bridge || typeof bridge.setConfig !== 'function') {
    mergeLocalConfig(patch)
    setError('')
    return true
  }
  try {
    const result = await bridge.setConfig(patch)
    if (!result || result.ok !== true) {
      setError((result && result.error) || '保存配置失败')
      return false
    }
    const config = asConfig(result.config)
    if (config) launcher.config = config
    setError('')
    return true
  } catch (error) {
    setError(`保存配置失败：${toMessage(error)}`)
    return false
  }
}

/** 更新秘密（adminPassword / neteaseCookie / biliCookie）；传空串表示清除该项。 */
export async function setSecrets(patch) {
  if (!hasBridgeMethod('setSecrets')) return failLocal('非 Electron 环境：无法保存秘密')
  try {
    const result = await getBridge().setSecrets(patch || {})
    if (!result || result.ok !== true) {
      setError((result && result.error) || '保存秘密失败')
      return false
    }
    const config = asConfig(result.config)
    if (config) launcher.config = config
    setError('')
    return true
  } catch (error) {
    setError(`保存秘密失败：${toMessage(error)}`)
    return false
  }
}

/** 清除秘密（可指定 keys: ['adminPassword'|'neteaseCookie'|'biliCookie']）。 */
export async function clearSecrets(options) {
  if (!hasBridgeMethod('clearSecrets')) return failLocal('非 Electron 环境：无法清除秘密')
  try {
    const result = await getBridge().clearSecrets(options || {})
    if (!result || result.ok !== true) {
      setError((result && result.error) || '清除秘密失败')
      return false
    }
    const config = asConfig(result.config)
    if (config) launcher.config = config
    setError('')
    return true
  } catch (error) {
    setError(`清除秘密失败：${toMessage(error)}`)
    return false
  }
}

/**
 * 首次启动：没有管理员密码时生成 24+ 字符强随机密码并保存。
 * 返回 `{ ok, generated, set, password? }`；password 仅在本次生成时返回（本机 UI 展示用）。
 */
export async function ensureLocalAdminPassword() {
  if (!hasBridgeMethod('ensureLocalAdminPassword')) {
    return { ok: false, generated: false, set: false, error: '非 Electron 环境：无法生成本机管理员密码' }
  }
  try {
    const result = await getBridge().ensureLocalAdminPassword()
    if (result && result.ok === true) {
      const config = asConfig(result.config)
      if (config) launcher.config = config
      setError('')
    } else if (result) {
      setError(result.error || '生成管理员密码失败')
    }
    return result || { ok: false, generated: false, set: false, error: '主进程没有返回结果' }
  } catch (error) {
    const message = `生成管理员密码失败：${toMessage(error)}`
    setError(message)
    return { ok: false, generated: false, set: false, error: message }
  }
}

/** 读取当前管理员密码明文（仅本机受信 UI；用于用户主动查看/复制）。 */
export async function revealLocalAdminPassword() {
  if (!hasBridgeMethod('revealLocalAdminPassword')) {
    return { ok: false, set: false, password: '', error: '非 Electron 环境：无法读取本机管理员密码' }
  }
  try {
    const result = await getBridge().revealLocalAdminPassword()
    if (result && result.ok !== true) setError(result.error || '读取管理员密码失败')
    return result || { ok: false, set: false, password: '' }
  } catch (error) {
    const message = `读取管理员密码失败：${toMessage(error)}`
    setError(message)
    return { ok: false, set: false, password: '', error: message }
  }
}

/** 启动本地服务（Java + 可选网易云 API）；成功返回 true。 */
export async function start() {
  if (!hasBridgeMethod('start')) {
    return failLocal('非 Electron 环境：无法启动本地服务')
  }
  if (launcher.busy) return false
  launcher.busy = true
  setError('')
  try {
    const result = await getBridge().start()
    return applyActionResult(result)
  } catch (error) {
    return failLocal(`启动服务失败：${toMessage(error)}`)
  } finally {
    launcher.busy = false
  }
}

/** 停止本地服务（幂等）；成功返回 true。 */
export async function stop() {
  if (!hasBridgeMethod('stop')) {
    return failLocal('非 Electron 环境：无法停止本地服务')
  }
  if (launcher.busy) return false
  launcher.busy = true
  setError('')
  try {
    const result = await getBridge().stop()
    return applyActionResult(result)
  } catch (error) {
    return failLocal(`停止服务失败：${toMessage(error)}`)
  } finally {
    launcher.busy = false
  }
}

/** 重启本地服务；成功返回 true。 */
export async function restart() {
  if (!hasBridgeMethod('restart')) {
    return failLocal('非 Electron 环境：无法重启本地服务')
  }
  if (launcher.busy) return false
  launcher.busy = true
  setError('')
  try {
    const result = await getBridge().restart()
    return applyActionResult(result)
  } catch (error) {
    return failLocal(`重启服务失败：${toMessage(error)}`)
  } finally {
    launcher.busy = false
  }
}

/** 拉取状态快照并同步到 launcher.status；返回 launcher.status。 */
export async function getStatus() {
  if (!hasBridgeMethod('status')) return launcher.status
  try {
    const snapshot = await getBridge().status()
    if (snapshot && typeof snapshot === 'object' && snapshot.ok === false) {
      setError(snapshot.error || '读取服务状态失败')
    } else {
      applyStatus(snapshot)
      setError('')
    }
  } catch (error) {
    setError(`读取服务状态失败：${toMessage(error)}`)
  }
  return launcher.status
}

/**
 * 把 status/resources 归一化成 UI 可直接使用的服务状态描述。
 *
 * kind:
 *  - `unsupported` 非 Electron（浏览器预览）：显示“桌面端可用”，不展示启动控件
 *  - `running`     Java 服务运行中（且 /api/config 已就绪）
 *  - `starting`    Java 进程已拉起，等待 /api/config 就绪
 *  - `degraded`    Java 进程活着但未就绪 / 网易云音源不可用（按音源降级）
 *  - `incompatible` Java 版本不兼容（需要 21+）
 *  - `ready`       资源已就绪（可启动）
 *  - `partial`     有内置资源但缺少某个文件
 *  - `not-bundled` 当前版本没有内置本地服务资源（公共版默认）→ 中性引导
 *  - `misconfigured` 用户显式配置了路径但文件不存在 → 引导重新选择文件
 *
 * @param {object} [status] 默认取 launcher.status
 */
export function describeServiceState(status) {
  const snapshot = status && typeof status === 'object' ? status : launcher.status
  const resources = { ...emptyResources(), ...(snapshot.resources || {}) }
  const javaService = (snapshot.services && snapshot.services.java) || {}
  const neteaseService = (snapshot.services && snapshot.services.netease) || {}
  const running = Boolean(snapshot.running)
  const javaState = javaService.state || (running ? 'running' : 'stopped')
  const missingCodes = Array.isArray(resources.missing) ? resources.missing.slice() : []
  const missingLabels = missingCodes.map((code) =>
    code === 'java' ? 'Java 运行时' : code === 'jar' ? 'server.jar' : String(code)
  )
  const missingText = missingLabels.length ? `缺少 ${missingLabels.join(' 与 ')}` : ''
  const misconfigured =
    (['configured', 'env'].includes(resources.javaSource) && !resources.javaFound) ||
    (['configured', 'env'].includes(resources.jarSource) && !resources.jarFound)

  let kind
  let label
  if (!launcher.available) {
    kind = 'unsupported'
    label = '桌面端可用'
  } else if (javaState === 'ready' || (running && javaService.healthy)) {
    kind = 'running'
    label = '运行中'
  } else if (javaState === 'incompatible') {
    kind = 'incompatible'
    label = 'Java 版本不兼容'
  } else if (javaState === 'starting') {
    kind = 'starting'
    label = '启动中'
  } else if (javaState === 'degraded') {
    kind = 'degraded'
    label = '服务未就绪'
  } else if (javaState === 'error') {
    kind = 'error'
    label = '启动失败'
  } else if (resources.ready && (resources.java.compatible || resources.java.compatible == null)) {
    kind = 'ready'
    label = '已配置'
  } else if (misconfigured) {
    kind = 'misconfigured'
    label = '未配置'
  } else if (resources.bundled) {
    kind = 'partial'
    label = '未配置'
  } else {
    kind = 'not-bundled'
    label = '未内置'
  }

  return {
    kind,
    label,
    javaState,
    neteaseState: neteaseService.state || 'stopped',
    systemState: (snapshot.services && snapshot.services.system && snapshot.services.system.state) || 'stopped',
    missingCodes,
    missingLabels,
    missingText,
    resources
  }
}

/** 在系统文件管理器中打开数据目录（userData）；成功返回 true。 */
export async function openDataDir() {
  if (!hasBridgeMethod('openDataDir')) {
    return failLocal('非 Electron 环境：没有可打开的启动器数据目录')
  }
  try {
    const result = await getBridge().openDataDir()
    if (!result || result.ok === false) {
      setError((result && result.error) || '打开数据目录失败')
      return false
    }
    setError('')
    return true
  } catch (error) {
    setError(`打开数据目录失败：${toMessage(error)}`)
    return false
  }
}

/**
 * 打开系统文件选择器，选择 Java 可执行文件或 server.jar。
 * 只负责“选文件”，不写配置；调用方拿到 path 后自行 setConfig。
 * 取消选择不是错误（ok:false + canceled:true），不会污染 launcher.error。
 *
 * @param {'java'|'jar'} kind
 * @returns {Promise<{ok: boolean, path?: string, canceled?: boolean, kind?: string, error?: string}>}
 */
export async function pickFile(kind) {
  if (kind !== 'java' && kind !== 'jar') {
    return { ok: false, canceled: false, error: '未知的文件类型（仅支持 java / jar）' }
  }
  if (!hasBridgeMethod('pickFile')) {
    return { ok: false, canceled: false, kind, error: '非 Electron 环境：不支持系统文件选择' }
  }
  try {
    const result = await getBridge().pickFile(kind)
    if (!result || typeof result !== 'object') {
      return { ok: false, canceled: false, kind, error: '文件选择没有返回结果' }
    }
    if (result.canceled) return { ok: false, canceled: true, kind }
    if (result.ok !== true || !result.path) {
      return { ok: false, canceled: false, kind, error: result.error || '选择文件失败' }
    }
    return { ok: true, canceled: false, kind, path: String(result.path) }
  } catch (error) {
    return { ok: false, canceled: false, kind, error: `选择文件失败：${toMessage(error)}` }
  }
}

/**
 * 订阅主进程日志。
 * @param {(entry: {service: 'java'|'netease'|'system', line: string, time: string}) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onLog(callback) {
  if (typeof callback !== 'function') return () => {}
  if (!getBridge()) return () => {}
  logListeners.add(callback)
  return () => {
    logListeners.delete(callback)
  }
}

/**
 * 订阅主进程状态广播。
 * @param {(snapshot: object) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onStatus(callback) {
  if (typeof callback !== 'function') return () => {}
  if (!getBridge()) return () => {}
  statusListeners.add(callback)
  return () => {
    statusListeners.delete(callback)
  }
}

/** 清空本地日志数组（主进程环形缓冲不受影响）。 */
export function clearLogs() {
  launcher.logs.splice(0, launcher.logs.length)
}

// 兼容命名：部分调用方习惯 loadConfig / saveConfig。
export { getConfig as loadConfig, setConfig as saveConfig }
// 桥方法契约名是 status()，这里同时导出 getStatus 与 status 两个名字。
export { getStatus as status }

// 模块加载即开始接收 launcher:log / launcher:status 广播（非 Electron 环境为空操作）。
subscribeBridge()

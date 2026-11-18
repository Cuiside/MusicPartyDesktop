'use strict'

/**
 * MusicParty 桌面端启动器（Electron 主进程模块，CommonJS）。
 *
 * 审计修复（2026-11-10）覆盖：
 *  - D-03 秘密存储：adminPassword / neteaseCookie / biliCookie 不再写入 launcher.json，
 *    改为独立 secrets 文件（Electron safeStorage 加密；不可用时受限权限文件 + 告警），
 *    旧配置启动时自动迁移；Java 启动参数不再携带秘密，改用环境变量
 *    APP_MUSICAPI_ADMINPASSWORD / APP_MUSICAPI_NETEASE_COOKIE / APP_MUSICAPI_BILIBILI_COOKIE；
 *    日志/错误/诊断一律脱敏。getConfig IPC 只返回脱敏配置（*Set:boolean）。
 *  - D-04 健康分离：Java 进程存活、MusicParty ready（GET /api/config 2xx+预期 JSON）、
 *    网易云 API ready（GET <neteaseApiBaseUrl>/inner/version 2xx+JSON）分开报告；
 *    网易云可用 URL 可配置（环境变量 MP_NETEASE_API_BASE_URL 优先），缺失按音源降级、
 *    不阻塞 Java；4xx/5xx/HTML/超时/重定向都不算健康。
 *  - D-09 首启管理员密码：没有已保存的非空管理员密码时拒绝启动本地 Java
 *    （返回 needsAdminPassword:true）；ensureLocalAdminPassword() 生成 24+ 字符强随机密码；
 *    默认监听 127.0.0.1，公网/局域网监听给明确告警。
 *  - D-10 单一配置 schema：DEFAULT_CONFIG / STRING_FIELDS / BOOLEAN_FIELDS /
 *    INTEGER_FIELDS / CONFIG_FIELDS 全部由 CONFIG_SCHEMA 生成（含 biliCookie、
 *    neteaseApiBaseUrl、serverIp/serverPort…）；只有未知字段才 ignored。
 *  - D-11 Java 兼容：探测 `java -XshowSettings:properties -version`（超时 5s）解析
 *    java.specification.version，要求 major >= 21；多候选选兼容者；spawn 后 3s 内退出或
 *    UnsupportedClassVersionError 时给出可理解错误，不把 spawned 当成 ready。
 *
 * 本模块不直接 require('electron')：ipcMain / app / safeStorage 等由 main.cjs 注入，
 * 因此可以在纯 Node 环境下用 mock 做回归测试（scripts/launcher-smoke.cjs）。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const { createSecretsStore, SECRET_KEYS, SECRET_LABELS } = require('./launcher-secrets.cjs')
const { REQUIRED_JAVA_MAJOR, resolveJava, probeJava } = require('./launcher-java.cjs')
const { probeMusicParty, probeNeteaseApi, redactSecrets } = require('./launcher-health.cjs')
const { isTrustedRendererFrame } = require('./http-bridge.cjs')

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const IS_WINDOWS = process.platform === 'win32'

const CONFIG_FILE_NAME = 'launcher.json'
const LOG_LIMIT = 500
const HEALTH_INTERVAL_MS = 3000
const HEALTH_TIMEOUT_MS = 2500
const SPAWN_CONFIRM_TIMEOUT_MS = 5000
// Java 进程启动后 3s 内退出 = 启动失败（D-11：不能把 spawned 当 ready）。
const SPAWN_EARLY_EXIT_WINDOW_MS = 3000
// 进程活着但 /api/config 还未就绪的宽限时间（Spring Boot 冷启动通常 3–10s）。
const JAVA_STARTUP_GRACE_MS = 30000
const JAVA_RUNTIME_CACHE_MS = 30000
const STOP_TIMEOUT_MS = 5000
const AUTO_START_DELAY_MS = 1200
const DEFAULT_NETEASE_API_BASE_URL = 'http://127.0.0.1:3000'
const MIN_ADMIN_PASSWORD_LENGTH = 24

// 内置资源在磁盘上的位置（相对 bin/ 目录）。打包后 bin/ 可能在
// app.asar.unpacked/bin 或 electron-builder extraResources 的 resources/bin。
const BUNDLED_JAVA_REL = ['jre', 'bin', IS_WINDOWS ? 'java.exe' : 'java']
const BUNDLED_JAR_NAME = 'server.jar'
const BUNDLED_NETEASE_NAME = IS_WINDOWS ? 'netease-api.exe' : 'netease-api'

const EVENT_LOG = 'launcher:log'
const EVENT_STATUS = 'launcher:status'

const IPC_CHANNELS = {
  configGet: 'launcher:config:get',
  configSet: 'launcher:config:set',
  start: 'launcher:start',
  stop: 'launcher:stop',
  restart: 'launcher:restart',
  status: 'launcher:status',
  openDataDir: 'launcher:openDataDir',
  pickFile: 'launcher:pickFile',
  secretsSet: 'launcher:secrets:set',
  secretsClear: 'launcher:secrets:clear',
  ensureAdminPassword: 'launcher:secrets:ensureAdminPassword',
  revealAdminPassword: 'launcher:secrets:revealAdminPassword',
  clearLocalData: 'launcher:data:clear'
}

const IPC_CHANNEL_LIST = Object.values(IPC_CHANNELS)

const SERVICE_LABELS = { java: 'Java 服务', netease: '网易云 API', qqmusic: 'QQ音乐 API' }
const LOG_SERVICES = new Set(['java', 'netease', 'system'])

const SECRET_ENV_VARS = Object.freeze({
  adminPassword: 'APP_MUSICAPI_ADMINPASSWORD',
  neteaseCookie: 'APP_MUSICAPI_NETEASE_COOKIE',
  biliCookie: 'APP_MUSICAPI_BILIBILI_COOKIE'
})

/** launcher:pickFile 支持的文件类型（kind -> 对话框配置）。 */
const PICK_FILE_SPECS = {
  java: {
    title: '选择 Java 可执行文件（需要 Java 21+）',
    filters: IS_WINDOWS
      ? [{ name: 'Java 可执行文件', extensions: ['exe'] }]
      : [{ name: '可执行文件', extensions: ['*'] }]
  },
  jar: {
    title: '选择 server.jar',
    filters: [{ name: 'Java 服务端程序包', extensions: ['jar'] }]
  }
}

/* ------------------------------------------------------------------ */
/* 配置 schema（D-10 单一来源）                                         */
/* ------------------------------------------------------------------ */

/**
 * 单一 schema：键、类型、默认值、是否秘密。DEFAULT_CONFIG / 各类型字段列表 /
 * CONFIG_FIELDS 全部由它生成；新增字段只改这里一处。
 *
 * 秘密字段（adminPassword / neteaseCookie / biliCookie）不进入 launcher.json，
 * 由 launcher-secrets.cjs 管理；它们在 schema 里声明是为了 setConfig 兼容路由与
 * 前端字段完整性。
 */
const CONFIG_SCHEMA = Object.freeze([
  // 服务
  { key: 'serverIp', type: 'string', default: '127.0.0.1' },
  { key: 'serverPort', type: 'port', default: '8080' },
  { key: 'baseUrl', type: 'string', default: 'http://localhost:8080' },
  // 应用
  { key: 'adminPassword', type: 'string', default: '', secret: true },
  { key: 'authorName', type: 'string', default: 'ThorNex' },
  { key: 'backWords', type: 'string', default: 'THORNEX' },
  // 网易云
  { key: 'neteaseCookie', type: 'string', default: '', secret: true },
  { key: 'neteaseQuality', type: 'string', default: 'exhigh' },
  { key: 'neteaseEnabled', type: 'boolean', default: true },
  { key: 'neteaseApiBaseUrl', type: 'string', default: DEFAULT_NETEASE_API_BASE_URL },
  // B 站
  { key: 'biliCookie', type: 'string', default: '', secret: true },
  { key: 'bilibiliEnabled', type: 'boolean', default: true },
  { key: 'qqmusicEnabled', type: 'boolean', default: true },
  // 队列
  { key: 'queueMaxSize', type: 'integer', default: 1000 },
  { key: 'queueHistorySize', type: 'integer', default: 50 },
  { key: 'queueMaxUserSongs', type: 'integer', default: 100 },
  // 播放器
  { key: 'maxPlaylistImportSize', type: 'integer', default: 100 },
  // 聊天
  { key: 'chatMaxHistorySize', type: 'integer', default: 1000 },
  { key: 'chatMinIntervalMs', type: 'integer', default: 1000 },
  { key: 'chatMaxMessageLength', type: 'integer', default: 200 },
  // 缓存
  { key: 'cacheMaxSize', type: 'string', default: '1GB' },
  // 认证限流
  { key: 'authRateLimitEnabled', type: 'boolean', default: true },
  { key: 'authMaxAttempts', type: 'integer', default: 5 },
  { key: 'authWindowSeconds', type: 'integer', default: 60 },
  { key: 'authBlockDuration', type: 'integer', default: 300 },
  // 启动器扩展
  { key: 'autoStart', type: 'boolean', default: false },
  { key: 'javaPath', type: 'string', default: '' },
  { key: 'serverJar', type: 'string', default: '' },
  { key: 'neteaseApiPath', type: 'string', default: '' }
])

const SECRET_FIELDS = new Set(CONFIG_SCHEMA.filter((field) => field.secret).map((field) => field.key))
const NON_SECRET_SCHEMA = CONFIG_SCHEMA.filter((field) => !field.secret)

/** 默认值（仅非秘密字段；秘密字段永不写入 launcher.json）。 */
const DEFAULT_CONFIG = Object.freeze(
  Object.fromEntries(NON_SECRET_SCHEMA.map((field) => [field.key, field.default]))
)

const STRING_FIELDS = NON_SECRET_SCHEMA.filter((field) => field.type === 'string').map((field) => field.key)
const BOOLEAN_FIELDS = NON_SECRET_SCHEMA.filter((field) => field.type === 'boolean').map((field) => field.key)
const INTEGER_FIELDS = NON_SECRET_SCHEMA.filter((field) => field.type === 'integer').map((field) => field.key)
const PORT_FIELDS = NON_SECRET_SCHEMA.filter((field) => field.type === 'port').map((field) => field.key)
const CONFIG_FIELDS = new Set(CONFIG_SCHEMA.map((field) => field.key))
const JAVA_INT_MAX = 2147483647

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function isValidInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= JAVA_INT_MAX
  )
}

function isStringField(key) {
  return STRING_FIELDS.includes(key)
}

function normalizeServerIp(value) {
  const text = String(value).trim()
  if (!text) return ''
  return /^[A-Za-z0-9.:[\]_-]{1,255}$/.test(text) ? text : null
}

/**
 * 把任意输入归一化成合法配置：
 *  - 以 base 为底（默认 DEFAULT_CONFIG）
 *  - 未知字段直接忽略
 *  - 类型不合法 / 数值越界的字段保留 base 中的值
 *  - 秘密字段不进入配置对象（setConfig 会单独转存 secrets）
 */
function normalizeConfig(input, base = DEFAULT_CONFIG) {
  const out = { ...base }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out

  for (const key of STRING_FIELDS) {
    if (!hasOwn(input, key) || typeof input[key] !== 'string') continue
    if (key === 'serverIp') {
      const normalized = normalizeServerIp(input[key])
      if (normalized != null) out[key] = normalized
    } else if (key === 'neteaseApiBaseUrl') {
      out[key] = input[key].trim().replace(/\/+$/, '')
    } else {
      out[key] = input[key]
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    if (hasOwn(input, key) && typeof input[key] === 'boolean') out[key] = input[key]
  }
  for (const key of INTEGER_FIELDS) {
    if (hasOwn(input, key) && isValidInteger(input[key])) out[key] = input[key]
  }
  for (const key of PORT_FIELDS) {
    if (!hasOwn(input, key)) continue
    const raw = input[key]
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
    if (/^\d{1,5}$/.test(text)) {
      const port = Number(text)
      if (port >= 1 && port <= 65535) out[key] = String(port)
    }
  }
  return out
}

function isLoopbackHost(host) {
  const text = String(host || '').trim().toLowerCase()
  if (!text) return false
  if (text === 'localhost' || text === '127.0.0.1' || text === '::1' || text === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)
}

function isLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''))
    return isLoopbackHost(parsed.hostname)
  } catch (_) {
    return false
  }
}

function portFromUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''))
    if (parsed.port) return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch (_) {
    return 0
  }
}

/* ------------------------------------------------------------------ */
/* Java 日志错误识别（D-11 / 端口占用）                                 */
/* ------------------------------------------------------------------ */

const JAVA_ERROR_PATTERNS = [
  {
    test: (line) => /UnsupportedClassVersionError/i.test(line),
    message: () =>
      `server.jar 需要 Java ${REQUIRED_JAVA_MAJOR}+，当前 Java 版本不兼容（UnsupportedClassVersionError）。请安装或选择 Java ${REQUIRED_JAVA_MAJOR} 或更高版本。`,
    fatal: true
  },
  {
    test: (line) => /class file version\s+\d+/i.test(line),
    message: (line) => {
      const match = /class file version\s+(\d+)/i.exec(line)
      return `server.jar 的 class 文件版本为 ${match ? match[1] : '?'}，需要 Java ${REQUIRED_JAVA_MAJOR}+ 才能运行（当前 Java 版本过低）`
    },
    fatal: true
  },
  {
    test: (line) => /has been compiled by a more recent version of the Java Runtime/i.test(line),
    message: () => `server.jar 由更高版本 Java 编译，需要 Java ${REQUIRED_JAVA_MAJOR}+`,
    fatal: true
  },
  {
    test: (line) => /Invalid or corrupt jarfile/i.test(line),
    message: () => 'server.jar 无法被 Java 读取（Invalid or corrupt jarfile），文件可能损坏或不完整',
    fatal: true
  },
  {
    test: (line) => /port\s+\d+\s+(?:is|was)\s+already\s+in\s+use/i.test(line),
    message: (_line, context) => `端口 ${context.serverPort || '8080'} 已被占用，无法启动 Java 服务`
  },
  {
    test: (line) => /web\s+server\s+failed\s+to\s+start/i.test(line),
    message: (_line, context) => `端口 ${context.serverPort || '8080'} 已被占用或无法绑定，Java 服务启动失败`
  },
  {
    test: (line) => /address\s+already\s+in\s+use|BindException/i.test(line),
    message: (_line, context) => `端口 ${context.serverPort || '8080'} 已被占用，无法启动 Java 服务`
  },
  {
    test: (line) => /APPLICATION\s+FAILED\s+TO\s+START/i.test(line),
    message: () => 'Java 服务启动失败（APPLICATION FAILED TO START），请查看日志'
  },
  {
    test: (line) => /OutOfMemoryError/i.test(line),
    message: () => 'Java 服务内存不足（OutOfMemoryError），请检查 JVM 内存设置'
  }
]

/**
 * 分析一行 Java 日志；返回人类可读错误或 null。
 * @param {string} line
 * @param {{serverPort?: string}} [context]
 * @returns {{message: string, fatal: boolean}|null}
 */
function analyzeJavaLogLine(line, context = {}) {
  const text = String(line == null ? '' : line)
  for (const pattern of JAVA_ERROR_PATTERNS) {
    if (pattern.test(text)) {
      return { message: pattern.message(text, context || {}), fatal: Boolean(pattern.fatal) }
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 单例                                                                */
/* ------------------------------------------------------------------ */

/** @type {ReturnType<typeof createLauncher> | null} */
let singleton = null

/**
 * 注册启动器（每个主进程只调用一次；重复调用返回同一实例）。
 *
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').App} deps.app
 * @param {() => import('electron').BrowserWindow | null} deps.getWindow
 * @param {object} [deps.safeStorage] Electron safeStorage（测试可注入 mock）
 * @param {object} [deps.shell] 可选的 Electron shell
 * @param {object} [deps.dialog] 可选的 Electron dialog
 * @param {typeof fetch} [deps.fetchImpl] 健康检查 fetch（测试可注入）
 * @param {(exe: string) => Promise<object>} [deps.javaProbe] Java 版本探测（测试可注入）
 * @returns {object} launcher 实例
 */
function registerLauncher(deps = {}) {
  if (singleton) return singleton

  const { ipcMain, app } = deps
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('registerLauncher({ ipcMain, app, getWindow }): 缺少合法的 ipcMain.handle')
  }
  if (!app || typeof app.getPath !== 'function') {
    throw new TypeError('registerLauncher({ ipcMain, app, getWindow }): 缺少合法的 app.getPath')
  }

  singleton = createLauncher(deps)
  return singleton
}

/* ------------------------------------------------------------------ */
/* 实例                                                                */
/* ------------------------------------------------------------------ */

function createLauncher(deps) {
  const { ipcMain, app } = deps
  const injectedShell = deps.shell || null
  const injectedDialog = deps.dialog || null
  const injectedSafeStorage = deps.safeStorage || null
  const injectedFetch = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : null
  const injectedJavaProbe = typeof deps.javaProbe === 'function' ? deps.javaProbe : null
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null
  const onQuitFailed = typeof deps.onQuitFailed === 'function' ? deps.onQuitFailed : () => {}

  const state = {
    config: { ...DEFAULT_CONFIG },
    /** @type {Array<{service: string, line: string, time: string}>} */
    logs: [],
    /** @type {null | object} */
    java: null,
    /** @type {null | object} */
    netease: null,
    qqmusic: null,
    qqmusicBaseUrl: '',
    javaReady: false,
    javaHealthError: null,
    javaStartupError: null,
    neteaseHealth: null,
    neteaseProbed: false,
    neteaseSpawnError: null,
    serverInfo: null,
    healthTimer: null,
    healthPolling: false,
    fetchWarned: false,
    lastError: null,
    stopping: false,
    quitting: false,
    quitComplete: false,
    autoStartTimer: null,
    startingPromise: null,
    stoppingPromise: null,
    clearingPromise: null,
    /** Java 版本探测缓存 */
    javaRuntime: { key: '', at: 0, result: null, promise: null },
    /** server.jar 版本缓存（path|mtime） */
    jarVersions: new Map()
  }

  let self = null
  let secrets = null

  /* ---------------- 基础工具 ---------------- */

  function appPath() {
    try {
      return app.getAppPath()
    } catch (_) {
      return process.cwd()
    }
  }

  function dataDir() {
    try {
      return app.getPath('userData')
    } catch (_) {
      return path.join(process.cwd(), '.musicparty-data')
    }
  }

  function ensureDataDir() {
    const dir = dataDir()
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  function configPath() {
    return path.join(ensureDataDir(), CONFIG_FILE_NAME)
  }

  // 纯路径（不碰文件系统）：用于状态快照，避免每 3s 的健康检查广播里 mkdir。
  function configFilePath() {
    return path.join(dataDir(), CONFIG_FILE_NAME)
  }

  function isFile(target) {
    try {
      return fs.statSync(target).isFile()
    } catch (_) {
      return false
    }
  }

  function isDir(target) {
    try {
      return fs.statSync(target).isDirectory()
    } catch (_) {
      return false
    }
  }

  function getWindowSafe() {
    try {
      return getWindow ? getWindow() : null
    } catch (_) {
      return null
    }
  }

  function broadcast(channel, payload) {
    const win = getWindowSafe()
    if (!win) return
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return
    const contents = win.webContents
    if (!contents || typeof contents.send !== 'function') return
    try {
      contents.send(channel, payload)
    } catch (_) {
      /* 窗口销毁竞态：忽略 */
    }
  }

  /** 当前所有需要脱敏的值（secrets + 本进程可能继承的 APP_MUSICAPI_* 环境变量）。 */
  function secretValues() {
    const values = []
    for (const key of SECRET_KEYS) {
      const value = secrets ? secrets.get(key) : ''
      if (value) values.push(value)
    }
    for (const envName of Object.values(SECRET_ENV_VARS)) {
      const value = String(process.env[envName] || '')
      if (value.length >= 4) values.push(value)
    }
    return values
  }

  /** 对任意文本做秘密脱敏（日志、错误、诊断导出统一入口）。 */
  function sanitizeText(text) {
    return redactSecrets(text, secretValues())
  }

  function pushLog(service, line) {
    const entry = {
      service: LOG_SERVICES.has(service) ? service : 'system',
      line: sanitizeText(String(line == null ? '' : line)).replace(/\r$/, ''),
      time: new Date().toISOString()
    }
    if (!entry.line) return entry
    state.logs.push(entry)
    if (state.logs.length > LOG_LIMIT) {
      state.logs.splice(0, state.logs.length - LOG_LIMIT)
    }
    broadcast(EVENT_LOG, entry)
    return entry
  }

  function tailLogs(limit) {
    const size = Math.max(0, Number(limit) || 0)
    if (!size) return []
    return state.logs.slice(-size).map((entry) => ({
      service: entry.service,
      line: entry.line,
      time: entry.time
    }))
  }

  /* ---------------- 配置：读取 / 迁移 / 写入 ---------------- */

  function serializeConfig() {
    const body = {}
    for (const field of NON_SECRET_SCHEMA) body[field.key] = state.config[field.key]
    return `${JSON.stringify(body, null, 2)}\n`
  }

  function writeConfigFile() {
    const file = configPath()
    const body = serializeConfig()
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, body, 'utf8')
    try {
      fs.renameSync(temp, file)
    } catch (_) {
      // Windows 上极少数被占用的场景，退化为直接覆盖写。
      fs.writeFileSync(file, body, 'utf8')
      try {
        fs.rmSync(temp, { force: true })
      } catch (_) {
        /* ignore */
      }
    }
    return file
  }

  /**
   * 读取配置并把旧 launcher.json 中的明文秘密迁出：
   *  - 解析失败 → 默认配置 + WARN
   *  - 明文字段 → secrets 存储（原子写）→ 从 launcher.json 删掉并立即回写
   */
  function loadConfigAndSecrets() {
    const file = configPath()
    let raw = null
    let readError = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      readError = error
    }
    if (readError && readError.code !== 'ENOENT') {
      pushLog('system', `[WARN] 读取配置 ${file} 失败：${String(readError.message || readError)}，使用默认配置`)
      raw = null
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
    const hadSecretKeys = SECRET_KEYS.some((key) => hasOwn(raw, key))
    let migrated
    try {
      migrated = secrets.migrateFromConfig(raw)
    } catch (error) {
      pushLog('system', `[WARN] 迁移旧配置中的秘密失败：${String((error && error.message) || error)}`)
      migrated = { migrated: [], config: raw }
    }
    state.config = normalizeConfig(migrated.config)
    if (hadSecretKeys) {
      try {
        writeConfigFile()
        pushLog('system', '已从 launcher.json 移除明文秘密字段（迁移到秘密存储，未记录具体值）')
      } catch (error) {
        pushLog('system', `[ERROR] 回写 launcher.json 失败：${String((error && error.message) || error)}`)
      }
    }
  }

  /** 供 getConfig IPC / 状态使用的脱敏配置。 */
  function redactedConfig() {
    const out = {}
    for (const field of NON_SECRET_SCHEMA) out[field.key] = state.config[field.key]
    out.adminPasswordSet = secrets.isSet('adminPassword')
    out.neteaseCookieSet = secrets.isSet('neteaseCookie')
    out.biliCookieSet = secrets.isSet('biliCookie')
    out.secretsStorage = secrets.describe()
    out.neteaseApiBaseUrlEffective = effectiveNeteaseBaseUrl()
    return out
  }

  function effectiveNeteaseBaseUrl() {
    const envValue = String(process.env.MP_NETEASE_API_BASE_URL || '').trim()
    const raw = envValue || state.config.neteaseApiBaseUrl || DEFAULT_NETEASE_API_BASE_URL
    return String(raw).trim().replace(/\/+$/, '')
  }

  function neteaseMode() {
    if (!state.config.neteaseEnabled) return 'disabled'
    const resources = probeResources()
    if (resources.neteaseApi.found && isLoopbackUrl(effectiveNeteaseBaseUrl())) return 'local'
    return 'external'
  }

  function configWarnings() {
    const warnings = []
    const ip = String(state.config.serverIp || '').trim()
    if (!isLoopbackHost(ip)) {
      warnings.push(
        `监听地址 ${ip || '（空 = 全部网卡）'} 不是回环地址：局域网/公网可能直接访问本地服务；如非必要请改回 127.0.0.1`
      )
    }
    if (!state.config.neteaseEnabled) {
      warnings.push('网易云音源已关闭：仅使用 B 站/本地音源')
    }
    return warnings
  }

  /* ---------------- 资源探测（启动前检查，不 spawn 任何进程） ---------------- */

  function isPackagedApp() {
    try {
      return Boolean(app.isPackaged)
    } catch (_) {
      return false
    }
  }

  /**
   * bin/ 资源候选目录：
   *  - 开发态 / 未打包：<appPath>/bin
   *  - asar 打包：<appPath 去掉 app.asar>.unpacked/bin（electron-builder asarUnpack）
   *  - extraResources：<resourcesPath>/bin（local-server 变体使用）
   */
  function bundledBinDirs() {
    const appRoot = appPath()
    const binDirs = [path.join(appRoot, 'bin')]
    if (/app\.asar$/i.test(appRoot)) {
      binDirs.push(path.join(appRoot.replace(/app\.asar$/i, 'app.asar.unpacked'), 'bin'))
    }
    try {
      if (process.resourcesPath) binDirs.push(path.join(process.resourcesPath, 'bin'))
    } catch (_) {
      /* ignore */
    }
    return [...new Set(binDirs)]
  }

  function firstExistingFile(candidates) {
    for (const candidate of candidates) {
      if (candidate && isFile(candidate)) return candidate
    }
    return ''
  }

  function bundledJavaFile() {
    const binDirs = bundledBinDirs()
    return (
      firstExistingFile(binDirs.map((dir) => path.join(dir, ...BUNDLED_JAVA_REL))) ||
      path.join(binDirs[0], ...BUNDLED_JAVA_REL)
    )
  }

  function bundledJarFile() {
    return firstExistingFile(bundledBinDirs().map((dir) => path.join(dir, BUNDLED_JAR_NAME)))
  }

  /** 在 JAVA_HOME / PATH 中查找 java（只做 fs 探测；版本探测在 refreshJavaRuntime）。 */
  function findJavaOnPath() {
    const binary = IS_WINDOWS ? 'java.exe' : 'java'
    const javaHome = (process.env.JAVA_HOME || '').trim()
    if (javaHome) {
      const candidate = path.join(javaHome, 'bin', binary)
      if (isFile(candidate)) return candidate
    }
    const rawPath = process.env.PATH || process.env.Path || ''
    for (const dir of rawPath.split(path.delimiter)) {
      const trimmed = dir.trim()
      if (!trimmed) continue
      const candidate = path.join(trimmed, binary)
      if (isFile(candidate)) return candidate
    }
    return ''
  }

  /** 读取 server.jar 清单里的版本（Spring-Boot-Version / Implementation-Version）。 */
  function readJarVersion(jarPath) {
    if (!jarPath || !isFile(jarPath)) return ''
    let mtime = 0
    try {
      mtime = fs.statSync(jarPath).mtimeMs
    } catch (_) {
      return ''
    }
    const cacheKey = `${jarPath}|${mtime}`
    if (state.jarVersions.has(cacheKey)) return state.jarVersions.get(cacheKey)
    let version = ''
    try {
      const fd = fs.openSync(jarPath, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(512 * 1024, fs.fstatSync(fd).size))
        fs.readSync(fd, buffer, 0, buffer.length, 0)
        const text = buffer.toString('latin1')
        const springMatch = /Spring-Boot-Version:\s*([^\r\n]+)/i.exec(text)
        const implMatch = /Implementation-Version:\s*([^\r\n]+)/i.exec(text)
        version = (springMatch && springMatch[1].trim()) || (implMatch && implMatch[1].trim()) || ''
        if (version.length > 80) version = version.slice(0, 80)
      } finally {
        fs.closeSync(fd)
      }
    } catch (_) {
      version = ''
    }
    state.jarVersions.set(cacheKey, version)
    return version
  }

  function javaRuntimeKey() {
    return `${state.config.javaPath || ''}|${bundledJavaFile()}`
  }

  /**
   * 异步解析 Java 运行时（版本/兼容性）。探测较慢（要 spawn java -version），
   * 因此缓存结果并去重；状态快照里使用缓存结果，保证 buildStatus 是同步的。
   */
  function refreshJavaRuntime(options = {}) {
    const force = options.force === true
    const key = javaRuntimeKey()
    const now = Date.now()
    if (!force && state.javaRuntime.result && state.javaRuntime.key === key && now - state.javaRuntime.at < JAVA_RUNTIME_CACHE_MS) {
      return Promise.resolve(state.javaRuntime.result)
    }
    if (state.javaRuntime.promise && state.javaRuntime.key === key) return state.javaRuntime.promise
    state.javaRuntime.key = key
    const bundled = firstExistingFile([bundledJavaFile()])
    const probe = injectedJavaProbe
      ? (exe) => injectedJavaProbe(exe)
      : (exe) => probeJava(exe)
    const promise = resolveJava({
      configured: state.config.javaPath,
      bundled,
      probe
    })
      .then((result) => {
        state.javaRuntime.result = result
        state.javaRuntime.at = Date.now()
        state.javaRuntime.promise = null
        emitStatus()
        return result
      })
      .catch((error) => {
        state.javaRuntime.promise = null
        const result = {
          found: false,
          path: '',
          source: 'none',
          version: '',
          major: null,
          compatible: false,
          lastError: `Java 版本探测失败：${String((error && error.message) || error)}`,
          candidates: []
        }
        state.javaRuntime.result = result
        state.javaRuntime.at = Date.now()
        emitStatus()
        return result
      })
    state.javaRuntime.promise = promise
    return promise
  }

  function cachedJavaRuntime() {
    if (!state.javaRuntime.result) return null
    if (state.javaRuntime.key !== javaRuntimeKey()) return null
    return state.javaRuntime.result
  }

  /**
   * 探测本地服务资源，返回渲染层可直接展示/判断的结构：
   *   { java:{found,path,version,compatible,source,lastError},
   *     serverJar:{found,path,source,version},
   *     neteaseApi:{found,path,source,version,baseUrl,mode},
   *     bundled, binDir, ready, missing, source, packaged,
   *     + 兼容旧扁平字段 javaPath/javaFound/javaSource/jarPath/... }
   *
   * 查找顺序（每一类资源独立）：
   *  1. 用户在 launcher.json 中显式配置的路径（配置了但不存在 → 明确报“配置无效”，不回退）
   *  2. 内置 bin/（jre/bin/java、server.jar、netease-api）
   *  3. 开发环境允许的 MP_SERVER_JAR（仅 server.jar）
   *  4. 系统 PATH / JAVA_HOME 中的 java
   */
  function probeResources() {
    const binDirs = bundledBinDirs()
    const bundledJava = firstExistingFile(binDirs.map((dir) => path.join(dir, ...BUNDLED_JAVA_REL)))
    const bundledJar = firstExistingFile(binDirs.map((dir) => path.join(dir, BUNDLED_JAR_NAME)))
    const bundledNetease = firstExistingFile(binDirs.map((dir) => path.join(dir, BUNDLED_NETEASE_NAME)))

    const configuredJava = (state.config.javaPath || '').trim()
    const configuredJar = (state.config.serverJar || '').trim()
    const configuredNetease = (state.config.neteaseApiPath || '').trim()
    const envJar = (process.env.MP_SERVER_JAR || '').trim()

    let javaPath = ''
    let javaFound = false
    let javaSource = 'none'
    if (configuredJava) {
      javaSource = 'configured'
      javaPath = configuredJava
      javaFound = isFile(configuredJava)
    } else if (bundledJava) {
      javaSource = 'bundled'
      javaPath = bundledJava
      javaFound = true
    } else {
      const systemJava = findJavaOnPath()
      if (systemJava) {
        javaSource = 'system'
        javaPath = systemJava
        javaFound = true
      }
    }

    let jarPath = ''
    let jarFound = false
    let jarSource = 'none'
    if (configuredJar) {
      jarSource = 'configured'
      jarPath = configuredJar
      jarFound = isFile(configuredJar)
    } else if (bundledJar) {
      jarSource = 'bundled'
      jarPath = bundledJar
      jarFound = true
    } else if (envJar) {
      jarSource = 'env'
      jarPath = envJar
      jarFound = isFile(envJar)
    }

    let neteasePath = ''
    let neteaseFound = false
    let neteaseSource = 'none'
    if (configuredNetease) {
      neteaseSource = 'configured'
      neteasePath = configuredNetease
      neteaseFound = isFile(configuredNetease)
    } else if (bundledNetease) {
      neteaseSource = 'bundled'
      neteasePath = bundledNetease
      neteaseFound = true
    }

    const missing = []
    if (!javaFound) missing.push('java')
    if (!jarFound) missing.push('jar')

    const runtime = cachedJavaRuntime()
    const effectiveRuntime =
      runtime && (runtime.compatible || runtime.found || runtime.path)
        ? runtime
        : null

    const bundled = Boolean(bundledJava || bundledJar || bundledNetease)
    const sourceOrder = ['bundled', 'configured', 'env', 'system']
    const sources = [javaSource, jarSource, neteaseSource]
    const source = sourceOrder.find((candidate) => sources.includes(candidate)) || 'none'
    const binDir = binDirs.find((dir) => isDir(dir)) || binDirs[0]

    const javaInfo = {
      found: javaFound,
      path: (effectiveRuntime && effectiveRuntime.path) || javaPath,
      version: effectiveRuntime ? effectiveRuntime.version : '',
      compatible: effectiveRuntime ? Boolean(effectiveRuntime.compatible) : null,
      source: javaSource,
      lastError: effectiveRuntime ? effectiveRuntime.lastError || null : null
    }
    const ncmBaseUrl = effectiveNeteaseBaseUrl()
    const ncmMode = !state.config.neteaseEnabled ? 'disabled' : neteaseFound && isLoopbackUrl(ncmBaseUrl) ? 'local' : 'external'

    return {
      java: javaInfo,
      serverJar: { found: jarFound, path: jarPath, source: jarSource, version: readJarVersion(jarPath) },
      neteaseApi: {
        found: neteaseFound,
        path: neteasePath,
        source: neteaseSource,
        version: '',
        baseUrl: ncmBaseUrl,
        mode: ncmMode
      },
      // 旧扁平字段（UI 过渡期兼容）
      javaPath,
      javaFound,
      javaSource,
      jarPath,
      jarFound,
      jarSource,
      neteasePath,
      neteaseFound,
      neteaseSource,
      bundled,
      binDir,
      // ready 表示“文件层面已就绪”（Java 版本兼容性见 java.compatible / services.java.state）
      ready: missing.length === 0,
      missing,
      source,
      packaged: isPackagedApp()
    }
  }

  /** 资源缺失的人类可读说明（不包含堆栈，不出现 “异常退出 code=1”）。 */
  function describeResourceError(resources) {
    const parts = []
    if (!resources.javaFound) {
      if (resources.javaSource === 'configured') {
        parts.push(`未找到 Java 运行时（javaPath 指向的文件不存在：${resources.javaPath}）`)
      } else {
        parts.push('未找到 Java 运行时（内置 JRE、系统 Java 与自定义路径均不可用）')
      }
    }
    if (!resources.jarFound) {
      let reason = '请放置 bin/server.jar、设置环境变量 MP_SERVER_JAR，或在高级设置中选择文件'
      if (resources.jarSource === 'configured') {
        reason = `serverJar 指向的文件不存在：${resources.jarPath}`
      } else if (resources.jarSource === 'env') {
        reason = `环境变量 MP_SERVER_JAR 指向的文件不存在：${resources.jarPath}`
      }
      parts.push(`未找到 server.jar（${reason}）`)
    }
    return parts.join('；')
  }

  function buildChildEnv(exePath, includeSecrets = true) {
    const env = { ...process.env }
    // 先清掉可能从父进程继承的秘密环境变量，避免旧值覆盖 secrets 存储/泄漏。
    for (const envName of Object.values(SECRET_ENV_VARS)) delete env[envName]
    for (const key of SECRET_KEYS) {
      const value = secrets.get(key)
      if (includeSecrets && value) env[SECRET_ENV_VARS[key]] = value
    }
    const extra = bundledBinDirs()
    if (exePath && path.isAbsolute(exePath)) extra.unshift(path.dirname(exePath))
    const current = env.PATH || env.Path || ''
    env.PATH = [...extra, current].filter(Boolean).join(path.delimiter)
    return env
  }

  /**
   * Java 命令行参数：**不含任何秘密**（D-03）。秘密通过 buildChildEnv 的
   * APP_MUSICAPI_* 环境变量传递（Spring relaxed binding）。
   */
  function buildJavaArgs() {
    const config = state.config
    return [
      `--server.address=${config.serverIp || '127.0.0.1'}`,
      `--server.port=${config.serverPort}`,
      `--app.music-api.base-url=${config.baseUrl}`,
      `--app.music-api.author-name=${config.authorName}`,
      `--app.music-api.back-words=${config.backWords}`,
      `--app.music-api.netease.base-url=${effectiveNeteaseBaseUrl()}`,
      `--app.music-api.netease.quality=${config.neteaseQuality}`,
      `--app.music-api.sources.netease.enabled=${config.neteaseEnabled}`,
      `--app.music-api.sources.bilibili.enabled=${config.bilibiliEnabled}`,
      `--app.music-api.sources.qqmusic.enabled=${config.qqmusicEnabled && Boolean(state.qqmusicBaseUrl)}`,
      ...(state.qqmusicBaseUrl ? [`--app.music-api.qqmusic.base-url=${state.qqmusicBaseUrl}`] : []),
      `--app.music-api.queue.max-size=${config.queueMaxSize}`,
      `--app.music-api.queue.history-size=${config.queueHistorySize}`,
      `--app.music-api.queue.max-user-songs=${config.queueMaxUserSongs}`,
      `--app.music-api.player.max-playlist-import-size=${config.maxPlaylistImportSize}`,
      `--app.music-api.chat.max-history-size=${config.chatMaxHistorySize}`,
      `--app.music-api.chat.min-interval-ms=${config.chatMinIntervalMs}`,
      `--app.music-api.chat.max-message-length=${config.chatMaxMessageLength}`,
      `--app.music-api.cache.max-size=${config.cacheMaxSize}`,
      `--app.music-api.auth.rate-limit-enabled=${config.authRateLimitEnabled}`,
      `--app.music-api.auth.max-attempts=${config.authMaxAttempts}`,
      `--app.music-api.auth.window-seconds=${config.authWindowSeconds}`,
      `--app.music-api.auth.block-duration-seconds=${config.authBlockDuration}`,
      '--logging.level.root=INFO',
      '--logging.level.org.thornex.musicparty=DEBUG'
    ]
  }

  /* ---------------- 日志解析（端口占用 / 版本不兼容等错误识别） ---------------- */

  function handleServiceLine(name, line) {
    pushLog(name, line)
    const entry = state[name]
    if (!entry) return
    entry.recentLines = entry.recentLines || []
    entry.recentLines.push(String(line).slice(0, 2000))
    if (entry.recentLines.length > 60) entry.recentLines.splice(0, entry.recentLines.length - 60)
    const analyzed = analyzeJavaLogLine(line, { serverPort: state.config.serverPort })
    if (!analyzed) return
    entry.recentError = analyzed.message
    if (analyzed.fatal) {
      if (name === 'java') state.javaStartupError = analyzed.message
      setLastError(analyzed.message)
      killEntryDetached(entry)
    } else if (name === 'java') {
      setLastError(analyzed.message)
    }
  }

  function attachOutput(entry) {
    const streams = [entry.child.stdout, entry.child.stderr].filter(Boolean)
    for (const stream of streams) {
      const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
      reader.on('line', (line) => handleServiceLine(entry.name, line))
      reader.on('error', () => {
        /* 子进程退出时读流被销毁：忽略 */
      })
    }
  }

  /* ---------------- 子进程生命周期 ---------------- */

  function mapSpawnError(error, exe) {
    const code = error && error.code
    if (code === 'ENOENT') {
      return `找不到可执行文件：${exe}（请检查 javaPath / 是否安装了 Java）`
    }
    if (code === 'EACCES') return `没有执行权限：${exe}`
    if (code === 'EFTYPE' || code === 'ENOEXEC') {
      return `无法执行 ${exe}：文件不是可执行程序，请重新选择 Java 可执行文件或 server.jar`
    }
    if (code === 'EINVAL') return `无法执行 ${exe}：路径或参数无效，请重新选择文件`
    return `无法启动 ${exe}：${String((error && error.message) || error)}`
  }

  function waitForSpawn(child) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(error || null)
      }
      // 该监听器保持挂载，同时起到兜底“未处理 error 事件”的作用。
      child.on('error', finish)
      const timer = setTimeout(() => finish(null), SPAWN_CONFIRM_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      child.once('spawn', () => finish(null))
    })
  }

  /** 等待 earlyExitWindowMs 内是否退出；退出返回 {exited:true,code,signal}，否则 null。 */
  function waitForEarlyExit(entry, windowMs) {
    if (!entry || entry.exited) return Promise.resolve({ exited: true, code: entry.exitCode, signal: entry.exitSignal })
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          entry.child.removeListener('exit', onExit)
        } catch (_) {
          /* ignore */
        }
        resolve(value)
      }
      const onExit = (code, signal) => finish({ exited: true, code, signal })
      const timer = setTimeout(() => finish(null), windowMs)
      if (typeof timer.unref === 'function') timer.unref()
      entry.child.once('exit', onExit)
    })
  }

  async function launchService(name, exe, args, options = {}) {
    if (state.quitting) return { ok: false, error: '应用正在退出' }
    const label = SERVICE_LABELS[name] || name
    let child
    try {
      child = spawn(exe, args, {
        cwd: options.cwd || ensureDataDir(),
        windowsHide: true,
          env: options.env || (name === 'netease'
            ? { ...buildChildEnv(exe, false), HOST: '127.0.0.1', PORT: String(portFromUrl(effectiveNeteaseBaseUrl()) || 3000) }
            : buildChildEnv(exe)),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      return { ok: false, error: mapSpawnError(error, exe) }
    }

    const entry = {
      name,
      child,
      pid: child.pid || null,
      startedAt: Date.now(),
      exited: false,
      recentLines: [],
      recentError: null,
      exitCode: null,
      exitSignal: null
    }
    state[name] = entry
    attachOutput(entry)

    const spawnError = await waitForSpawn(child)
    if (spawnError) {
      entry.exited = true
      if (state[name] === entry) state[name] = null
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      return { ok: false, error: mapSpawnError(spawnError, exe) }
    }

    entry.pid = child.pid || entry.pid
    child.once('exit', (code, signal) => handleExit(entry, code, signal))
    child.on('error', (error) => {
      pushLog('system', `[WARN] ${label} 进程错误：${String((error && error.message) || error)}`)
    })
    pushLog('system', `${label} 已启动（pid ${entry.pid}）`)
    if (name === 'java') {
      state.javaReady = false
      state.javaHealthError = null
      state.javaStartupError = null
      state.serverInfo = null
      startHealthPoll()
    } else if (name === 'netease') {
      state.neteaseSpawnError = null
    }

    const earlyWindow = Number(options.earlyExitWindowMs) || 0
    if (earlyWindow > 0) {
      const early = await waitForEarlyExit(entry, earlyWindow)
      if (early && early.exited) {
        const failure = describeStartupFailure(entry, early.code)
        entry.startupFailed = true
        if (name === 'java') {
          state.javaStartupError = failure.message
          state.javaReady = false
        } else {
          state.neteaseSpawnError = failure.message
        }
        if (state[name] === entry) state[name] = null
        killEntryDetached(entry)
        return { ok: false, error: failure.message, exitCode: early.code, entry }
      }
    }
    return { ok: true, entry }
  }

  /** 启动即失败/提前退出时的可理解错误（优先使用日志里识别到的具体原因）。 */
  function describeStartupFailure(entry, code) {
    if (entry && entry.recentError) return { message: entry.recentError, fromLog: true }
    const context = state.config.serverPort
    const tail = entry && entry.recentLines && entry.recentLines.length > 0 ? entry.recentLines : []
    for (const line of tail) {
      const analyzed = analyzeJavaLogLine(line, { serverPort: context })
      if (analyzed) return { message: analyzed.message, fromLog: true }
    }
    if (code === 1) {
      return {
        message: `Java 服务启动后立即退出（退出码 1）。常见原因：Java 版本不兼容（需要 Java ${REQUIRED_JAVA_MAJOR}+）、端口 ${context} 被占用、server.jar 缺失或损坏。请查看最近日志。`,
        fromLog: false
      }
    }
    return {
      message: `Java 服务启动后立即退出（退出码 ${code == null ? 'null' : code}）。请查看最近日志，或在高级设置中检查 Java / server.jar / 端口。`,
      fromLog: false
    }
  }

  function handleExit(entry, code, signal) {
    if (entry.exited) return
    entry.exited = true
    entry.exitCode = code
    entry.exitSignal = signal
    if (state[entry.name] === entry) state[entry.name] = null
    const label = SERVICE_LABELS[entry.name] || entry.name
    pushLog(
      'system',
      `${label} 进程已退出（code=${code == null ? 'null' : code}, signal=${signal || 'null'}）`
    )

    if (entry.name === 'java') {
      stopHealthPoll()
      state.javaReady = false
      if (!state.stopping && !state.quitting) {
        if (state.javaStartupError) {
          // 具体原因（版本不兼容/端口占用…）已写入 lastError，不再用笼统退出码覆盖。
        } else if (code !== 0) {
          const failure = describeStartupFailure(entry, code)
          state.javaStartupError = failure.message
          setLastError(failure.message)
        } else {
          pushLog('system', '[WARN] Java 服务已退出')
        }
      }
    } else if (entry.name === 'netease' && !state.stopping && !state.quitting && code !== 0) {
      state.neteaseSpawnError = `网易云 API 异常退出（code=${code}）`
      pushLog('system', `[WARN] 网易云 API 异常退出（code=${code}）`)
    }
    emitStatus()
  }

  function waitForExit(entry, timeoutMs) {
    if (!entry || entry.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          entry.child.removeListener('exit', onExit)
          entry.child.removeListener('close', onExit)
        } catch (_) {
          /* ignore */
        }
        resolve(value)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      entry.child.once('exit', onExit)
      entry.child.once('close', onExit)
    })
  }

  function taskkill(pid) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch (_) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch (_) {
          /* ignore */
        }
        finish()
      }, 4000)
      if (typeof timer.unref === 'function') timer.unref()
      child.once('close', finish)
      child.once('error', finish)
    })
  }

  function killEntry(entry) {
    if (!entry || entry.exited) return Promise.resolve()
    const pid = entry.pid || (entry.child && entry.child.pid)
    if (!pid) {
      try {
        entry.child.kill('SIGKILL')
      } catch (_) {
        /* ignore */
      }
      return Promise.resolve()
    }
    if (IS_WINDOWS) return taskkill(pid)
    try {
      entry.child.kill('SIGTERM')
    } catch (_) {
      /* ignore */
    }
    return Promise.resolve()
  }

  function killEntryDetached(entry) {
    if (!entry || entry.exited) return
    const pid = entry.pid || (entry.child && entry.child.pid)
    if (!pid) {
      try {
        entry.child.kill()
      } catch (_) {
        /* ignore */
      }
      return
    }
    if (!IS_WINDOWS) {
      try {
        entry.child.kill('SIGTERM')
      } catch (_) {
        /* ignore */
      }
      return
    }
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true
      })
      killer.once('error', () => {
        /* ignore */
      })
      killer.unref()
    } catch (_) {
      /* ignore */
    }
  }

  async function stopEntry(entry) {
    if (!entry || entry.exited) return true
    await killEntry(entry)
    let exited = await waitForExit(entry, STOP_TIMEOUT_MS)
    if (!exited) {
      try {
        entry.child.kill(IS_WINDOWS ? undefined : 'SIGKILL')
      } catch (_) {
        /* ignore */
      }
      exited = await waitForExit(entry, 1500)
    }
    if (!exited) {
      pushLog(
        'system',
        `[WARN] ${SERVICE_LABELS[entry.name] || entry.name}（pid ${entry.pid}）未在预期时间内退出`
      )
    }
    return exited
  }

  /* ---------------- 健康检查（D-04：三态分离） ---------------- */

  function healthHost() {
    const ip = (state.config.serverIp || '').trim()
    // 监听 0.0.0.0 / ::（通配）时用回环地址探测；否则直接探测配置的监听地址。
    if (!ip || ip === '0.0.0.0' || ip === '::' || ip === '[::]') return '127.0.0.1'
    if (isLoopbackHost(ip)) return ip === 'localhost' ? '127.0.0.1' : ip
    return ip
  }

  function healthBaseUrl() {
    return `http://${healthHost()}:${state.config.serverPort}`
  }

  function healthUrl() {
    return `${healthBaseUrl()}/api/config`
  }

  function fetchImpl() {
    if (injectedFetch) return injectedFetch
    return typeof fetch === 'function' ? fetch : null
  }

  function stopHealthPoll() {
    if (state.healthTimer) {
      clearInterval(state.healthTimer)
      state.healthTimer = null
    }
    state.healthPolling = false
  }

  async function pollHealth() {
    if (state.healthPolling) return
    state.healthPolling = true
    const impl = fetchImpl()
    let mpResult = null
    let ncmResult = null
    try {
      if (impl && state.java && !state.java.exited) {
        mpResult = await probeMusicParty(healthBaseUrl(), { fetchImpl: impl, timeoutMs: HEALTH_TIMEOUT_MS })
      }
      if (impl && state.java && !state.java.exited && state.config.neteaseEnabled) {
        ncmResult = await probeNeteaseApi(effectiveNeteaseBaseUrl(), {
          fetchImpl: impl,
          timeoutMs: HEALTH_TIMEOUT_MS
        })
      }
      if (!impl && !state.fetchWarned) {
        state.fetchWarned = true
        pushLog('system', '[WARN] 当前 Node 运行时不支持 fetch，健康检查已跳过')
      }
    } finally {
      state.healthPolling = false
    }
    const javaRunning = Boolean(state.java && !state.java.exited)
    if (mpResult) {
      const wasReady = state.javaReady
      state.javaReady = Boolean(mpResult.ok) && javaRunning
      state.javaHealthError = mpResult.ok ? null : mpResult.error
      if (mpResult.server) state.serverInfo = mpResult.server
      if (state.javaReady !== wasReady) {
        pushLog('system', state.javaReady ? `健康检查通过：${healthUrl()}` : `[WARN] 服务未就绪：${mpResult.error}`)
      }
    } else if (!javaRunning) {
      state.javaReady = false
    }
    if (ncmResult) {
      const wasReady = Boolean(state.neteaseHealth && state.neteaseHealth.ok)
      state.neteaseProbed = true
      state.neteaseHealth = ncmResult
      if (ncmResult.ok !== wasReady) {
        pushLog(
          'system',
          ncmResult.ok
            ? `网易云 API 就绪：${effectiveNeteaseBaseUrl()}`
            : `[WARN] 网易云 API 不可用（Java 服务继续运行，网易云音源降级）：${ncmResult.error}`
        )
      }
    }
    emitStatus()
  }

  function startHealthPoll() {
    stopHealthPoll()
    void pollHealth()
    state.healthTimer = setInterval(() => {
      void pollHealth()
    }, HEALTH_INTERVAL_MS)
    if (typeof state.healthTimer.unref === 'function') state.healthTimer.unref()
  }

  /* ---------------- 状态快照 ---------------- */

  function computeJavaState(resources) {
    const entry = state.java
    const running = Boolean(entry && !entry.exited)
    if (running) {
      if (state.javaReady) return 'ready'
      const elapsed = Date.now() - (entry.startedAt || Date.now())
      return elapsed < JAVA_STARTUP_GRACE_MS ? 'starting' : 'degraded'
    }
    if (resources.missing.length > 0) return 'missing'
    if (state.javaStartupError) return 'error'
    const runtime = resources.java
    if (runtime.compatible === false) return 'incompatible'
    if (runtime.compatible == null) return 'probing'
    return 'stopped'
  }

  function computeNeteaseState(resources) {
    if (!state.config.neteaseEnabled) return 'disabled'
    const entry = state.netease
    const running = Boolean(entry && !entry.exited)
    const healthy = Boolean(state.neteaseHealth && state.neteaseHealth.ok)
    if (running) {
      if (healthy) return 'ready'
      const elapsed = Date.now() - (entry.startedAt || Date.now())
      return elapsed < JAVA_STARTUP_GRACE_MS ? 'starting' : 'unhealthy'
    }
    if (state.neteaseSpawnError) return 'error'
    if (healthy) return 'external'
    if (!state.neteaseProbed) return 'missing'
    return resources.neteaseApi.found || state.config.neteaseApiBaseUrl ? 'unhealthy' : 'missing'
  }

  function systemStateOf(javaState, neteaseState) {
    if (javaState === 'incompatible' || javaState === 'error') return 'error'
    const javaRunning = Boolean(state.java && !state.java.exited)
    if (!javaRunning && javaState !== 'ready') return 'stopped'
    if (!state.javaReady) return 'degraded'
    if (state.config.neteaseEnabled && ['unhealthy', 'error', 'missing'].includes(neteaseState)) return 'degraded'
    return 'ok'
  }

  function javaServiceLastError(resources, javaState) {
    if (state.javaStartupError) return state.javaStartupError
    if (javaState === 'incompatible') return resources.java.lastError
    if (javaState === 'missing') return describeResourceError(resources)
    if (javaState === 'probing') return null
    if (javaState === 'degraded') return state.javaHealthError || 'Java 进程存活，但 /api/config 未就绪'
    return null
  }

  function neteaseServiceLastError(neteaseState) {
    if (neteaseState === 'disabled') return null
    if (neteaseState === 'error') return state.neteaseSpawnError
    if (neteaseState === 'unhealthy' || neteaseState === 'missing') {
      return (state.neteaseHealth && state.neteaseHealth.error) || '网易云 API 不可用（不影响 Java 服务）'
    }
    return null
  }

  function buildStatus() {
    const resources = probeResources()
    const now = Date.now()
    const javaEntry = state.java
    const javaRunning = Boolean(javaEntry && !javaEntry.exited)
    const neteaseEntry = state.netease
    const neteaseRunning = Boolean(neteaseEntry && !neteaseEntry.exited)
    const javaState = computeJavaState(resources)
    const neteaseState = computeNeteaseState(resources)
    const systemState = systemStateOf(javaState, neteaseState)

    return {
      running: javaRunning,
      healthy: javaRunning && state.javaReady,
      degraded: systemState === 'degraded',
      baseUrl: state.config.baseUrl,
      needsAdminPassword: !secrets.isSet('adminPassword'),
      services: {
        java: {
          state: javaState,
          running: javaRunning,
          healthy: javaRunning && state.javaReady,
          pid: javaRunning ? javaEntry.pid || null : null,
          uptimeMs: javaRunning && javaEntry.startedAt ? Math.max(0, now - javaEntry.startedAt) : 0,
          version: resources.java.version || '',
          compatible: resources.java.compatible,
          lastError: javaServiceLastError(resources, javaState),
          candidates: cachedJavaRuntime() ? cachedJavaRuntime().candidates : []
        },
        netease: {
          state: neteaseState,
          running: neteaseRunning,
          healthy: neteaseRunning && Boolean(state.neteaseHealth && state.neteaseHealth.ok),
          pid: neteaseRunning ? neteaseEntry.pid || null : null,
          uptimeMs: neteaseRunning && neteaseEntry.startedAt ? Math.max(0, now - neteaseEntry.startedAt) : 0,
          version: (state.neteaseHealth && state.neteaseHealth.version) || '',
          compatible: null,
          baseUrl: effectiveNeteaseBaseUrl(),
          mode: neteaseMode(),
          lastError: neteaseServiceLastError(neteaseState)
        },
        system: {
          state: systemState,
          lastError:
            systemState === 'error' || systemState === 'degraded'
              ? javaServiceLastError(resources, javaState) || neteaseServiceLastError(neteaseState)
              : null
        }
      },
      server: state.serverInfo
        ? {
            ready: Boolean(state.javaReady),
            version: state.serverInfo.version || '',
            capabilities: state.serverInfo.capabilities || [],
            adminConfigured: state.serverInfo.adminConfigured,
            restProtectionEnabled: state.serverInfo.restProtectionEnabled,
            cookieSource: state.serverInfo.cookieSource || ''
          }
        : null,
      /** 资源探测结果：渲染层据此区分「未内置 / 已配置 / 运行中」。 */
      resources,
      warnings: configWarnings(),
      secretsStorage: secrets.describe(),
      lastError: state.lastError,
      /** 日志尾部（默认折叠展示；避免把原始堆栈当成主文案）。 */
      logTail: tailLogs(3),
      healthUrl: healthUrl(),
      dataDir: dataDir(),
      configPath: configFilePath(),
      logCount: state.logs.length,
      updatedAt: now
    }
  }

  function emitStatus() {
    broadcast(EVENT_STATUS, buildStatus())
  }

  function setLastError(message) {
    const sanitized = sanitizeText(message)
    if (!sanitized || state.lastError === sanitized) return
    state.lastError = sanitized
    pushLog('system', `[ERROR] ${sanitized}`)
    emitStatus()
  }

  function fail(message) {
    const sanitized = sanitizeText(message)
    state.lastError = sanitized
    pushLog('system', `[ERROR] ${sanitized}`)
    emitStatus()
    return { ok: false, error: sanitized, logTail: tailLogs(3), status: buildStatus() }
  }

  /**
   * 缺少资源时的结构化失败：不 spawn、不写 [ERROR] 日志、不产生“异常退出 code=1”。
   */
  function failMissingResources(resources) {
    const error = describeResourceError(resources)
    state.lastError = error
    emitStatus()
    return {
      ok: false,
      kind: 'resources-missing',
      error,
      missing: resources.missing.slice(),
      resources,
      logTail: [],
      status: buildStatus()
    }
  }

  /* ---------------- 配置 IPC ---------------- */

  function setSecrets(partial) {
    if (state.clearingPromise) return { ok: false, kind: 'clearing', error: '正在清除本地数据' }
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return { ok: false, error: '秘密参数必须是一个 JSON 对象' }
    }
    const rejected = []
    for (const key of SECRET_KEYS) {
      if (hasOwn(partial, key) && partial[key] != null && typeof partial[key] !== 'string') rejected.push(key)
    }
    if (hasOwn(partial, 'adminPassword') && typeof partial.adminPassword === 'string' && partial.adminPassword.trim() === '') {
      return { ok: false, error: '管理员密码不能为空或纯空白' }
    }
    let result
    try {
      result = secrets.setSecrets(partial)
    } catch (error) {
      return { ok: false, error: `保存秘密失败：${String((error && error.message) || error)}` }
    }
    const changedLabels = result.changed.map((key) => SECRET_LABELS[key] || key)
    if (changedLabels.length > 0) {
      // 只记录字段名，绝不记录值。
      pushLog('system', `秘密配置已更新：${changedLabels.join('、')}`)
      emitStatus()
    }
    return {
      ok: true,
      changed: result.changed,
      ignored: rejected,
      config: redactedConfig(),
      secretsStorage: secrets.describe()
    }
  }

  function clearSecrets(keys) {
    let result
    try {
      result = secrets.clearSecrets(keys)
    } catch (error) {
      return { ok: false, error: `清除秘密失败：${String((error && error.message) || error)}` }
    }
    if (result.cleared.length > 0) {
      pushLog('system', `已清除秘密：${result.cleared.map((key) => SECRET_LABELS[key] || key).join('、')}`)
      emitStatus()
    }
    return { ok: true, cleared: result.cleared, config: redactedConfig(), secretsStorage: secrets.describe() }
  }

  /** 生成 24+ 字符强随机管理员密码并保存；返回的明文只用于本次本机 UI 展示。 */
  function ensureLocalAdminPassword() {
    if (state.clearingPromise) return { ok: false, kind: 'clearing', error: '正在清除本地数据' }
    if (secrets.isSet('adminPassword')) {
      return { ok: true, generated: false, set: true, config: redactedConfig() }
    }
    const password = crypto.randomBytes(24).toString('base64url') // 32 字符
    if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
      return { ok: false, error: '生成的密码长度不足，已中止（请联系开发者）' }
    }
    try {
      secrets.setSecrets({ adminPassword: password })
    } catch (error) {
      return { ok: false, error: `保存管理员密码失败：${String((error && error.message) || error)}` }
    }
    pushLog('system', '已生成并保存本机管理员密码（仅本机可见，请妥善保管）')
    emitStatus()
    return {
      ok: true,
      generated: true,
      set: true,
      password,
      length: password.length,
      config: redactedConfig()
    }
  }

  /** 读取当前管理员密码明文（仅供本机受信 UI 显示/复制；IPC 层校验来源）。 */
  function revealLocalAdminPassword() {
    const password = secrets.get('adminPassword')
    return { ok: true, set: Boolean(password), password }
  }

  function setConfig(patch) {
    if (state.clearingPromise) return { ok: false, kind: 'clearing', error: '正在清除本地数据' }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: '配置必须是一个 JSON 对象' }
    }
    const previous = state.config
    const next = normalizeConfig(patch, previous)
    const changedKeys = Object.keys(next).filter((key) => next[key] !== previous[key])
    const ignoredKeys = Object.keys(patch).filter((key) => !CONFIG_FIELDS.has(key))

    // 秘密字段：兼容旧 setConfig 调用（UI 迁移到 setSecrets 前仍可用），写入秘密存储。
    const secretPatch = {}
    for (const key of SECRET_KEYS) {
      if (!hasOwn(patch, key)) continue
      if (typeof patch[key] === 'string') secretPatch[key] = patch[key]
      else if (!ignoredKeys.includes(key)) ignoredKeys.push(key)
    }
    if (hasOwn(secretPatch, 'adminPassword') && secretPatch.adminPassword.trim() === '') {
      return { ok: false, error: '管理员密码不能为空或纯空白', config: redactedConfig() }
    }

    if (changedKeys.length > 0) {
      state.config = next
      try {
        writeConfigFile()
      } catch (error) {
        state.config = previous
        return {
          ok: false,
          error: `保存配置失败：${String((error && error.message) || error)}`,
          config: redactedConfig()
        }
      }
    }

    let secretChanged = []
    if (Object.keys(secretPatch).length > 0) {
      try {
        secretChanged = secrets.setSecrets(secretPatch).changed
      } catch (error) {
        return {
          ok: false,
          error: `保存秘密失败：${String((error && error.message) || error)}`,
          config: redactedConfig()
        }
      }
    }

    const changed = [...changedKeys, ...secretChanged]
    if (changed.length > 0) {
      const labels = changed.map((key) => (SECRET_FIELDS.has(key) ? `${SECRET_LABELS[key] || key}（秘密，已脱敏）` : key))
      pushLog('system', `配置已更新：${labels.join(', ')}`)
      const needsRestart = changed.some((key) => key !== 'autoStart')
      if (needsRestart && (state.java || state.netease)) {
        pushLog('system', '[WARN] 配置已保存，重启本地服务后生效')
      }
    }
    if (changedKeys.includes('javaPath')) {
      // 路径变了：立即按新候选重新探测 Java 版本（异步，状态随后刷新）。
      void refreshJavaRuntime({ force: true })
    }
    emitStatus()
    return {
      ok: true,
      config: redactedConfig(),
      changed,
      ignored: ignoredKeys,
      warnings: configWarnings(),
      restartRequired: Boolean(state.java || state.netease) && changed.some((key) => key !== 'autoStart')
    }
  }

  /* ---------------- 启动 / 停止 ---------------- */

  function describeJavaIncompatible(runtime) {
    const version = runtime && runtime.version ? runtime.version : '未知'
    const major = runtime && runtime.major != null ? runtime.major : null
    const current = major != null ? String(major) : version
    const pathText = runtime && runtime.path ? `（${runtime.path}）` : ''
    return `需要 Java ${REQUIRED_JAVA_MAJOR}+，当前 ${current}${pathText}。请安装 Java ${REQUIRED_JAVA_MAJOR} 或更高版本，或在高级设置中选择兼容的 java.exe。`
  }

  async function ensureNeteaseApi(resources) {
    if (!state.config.neteaseEnabled) {
      pushLog('system', '网易云音源已关闭（neteaseEnabled=false），跳过网易云 API')
      return { ok: true, skipped: true, mode: 'disabled' }
    }
    if (state.netease && !state.netease.exited) return { ok: true, alreadyRunning: true, mode: 'local' }
    const baseUrl = effectiveNeteaseBaseUrl()
    const impl = fetchImpl()
    const probe = await probeNeteaseApi(baseUrl, { fetchImpl: impl, timeoutMs: HEALTH_TIMEOUT_MS })
    if (state.quitting) return { ok: false, error: '应用正在退出' }
    state.neteaseProbed = true
    if (probe.ok) {
      state.neteaseHealth = probe
      pushLog('system', `网易云 API 已就绪（${probe.fallback ? '根路径' : '/inner/version'}）：${baseUrl}`)
      return { ok: true, mode: 'external', version: probe.version }
    }
    const localBinary = resources.neteaseApi.found
    const localMode = localBinary && isLoopbackUrl(baseUrl)
    if (!localMode) {
      state.neteaseHealth = probe
      const reason = localBinary
        ? `配置的网易云 API 地址 ${baseUrl} 不可用`
        : '未内置 netease-api（可选组件）'
      pushLog('system', `[WARN] 跳过网易云 API：${reason}；继续启动 Java 服务，网易云音源将降级`)
      return { ok: false, skipped: true, mode: 'missing', reason: probe.error }
    }
    const port = portFromUrl(baseUrl) || 3000
    const result = await launchService('netease', resources.neteaseApi.path, ['-p', String(port)])
    if (!result.ok) {
      state.neteaseSpawnError = result.error
      state.neteaseHealth = probe
      pushLog('system', `[WARN] 网易云 API 启动失败：${result.error}（继续启动 Java 服务）`)
      return { ok: false, error: result.error, mode: 'local' }
    }
    pushLog('system', `网易云 API 正在启动（端口 ${port}）`)
    return { ok: true, mode: 'local' }
  }

  async function stopNeteaseApi() {
    const entry = state.netease
    if (!entry || entry.exited) {
      state.netease = null
      return
    }
    const exited = await stopEntry(entry)
    if (exited && state.netease === entry) state.netease = null
    return exited
  }

  async function stopQqmusicApi() {
    const entry = state.qqmusic
    state.qqmusicBaseUrl = ''
    if (!entry || entry.exited) { state.qqmusic = null; return true }
    const exited = await stopEntry(entry)
    if (exited && state.qqmusic === entry) state.qqmusic = null
    return exited
  }

  async function startQqmusicApi() {
    state.qqmusicBaseUrl = ''
    if (!state.config.qqmusicEnabled) return { ok: true, skipped: true }
    const python = firstExistingFile(bundledBinDirs().map(dir => path.join(dir, 'qqmusic-verified', 'python', 'python.exe')))
    if (!python) return { ok: false, error: '未找到内置 QQ 音乐 API 运行时' }
    const root = path.resolve(path.dirname(python), '..', 'upstream', 'source')
    const entry = path.join(root, 'web', 'run.py')
    if (!isFile(entry) || !isFile(path.join(root, 'web', 'src', 'app.py'))) return { ok: false, error: 'QQ 音乐 API 运行时不完整' }
    const port = await new Promise((resolve, reject) => {
      const socket = net.createServer()
      socket.once('error', reject)
      socket.listen(0, '127.0.0.1', () => { const n = socket.address().port; socket.close(() => resolve(n)) })
    })
    const childEnv = buildChildEnv(python, false)
    for (const key of Object.keys(childEnv)) if (/^(PYTHON|QQMUSIC_)/i.test(key)) delete childEnv[key]
    Object.assign(childEnv, { QQMUSIC_SERVER_HOST: '127.0.0.1', QQMUSIC_SERVER_PORT: String(port), QQMUSIC_SERVER_WORKERS: '1', QQMUSIC_CLIENT: JSON.stringify({ device_path: path.join(ensureDataDir(), 'qqmusic-device.json') }), QQMUSIC_CREDENTIAL: JSON.stringify({ enabled: false, store: { path: path.join(ensureDataDir(), 'qqmusic-credentials.sqlite3') } }), QQMUSIC_LOGGING_LEVEL: 'WARNING', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' })
    const result = await launchService('qqmusic', python, ['-I', '-B', entry], { cwd: root, env: childEnv })
    if (!result.ok) return result
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && state.qqmusic && !state.qqmusic.exited && !state.quitting) {
      try {
        const response = await fetchImpl()(`${url}/`, { signal: AbortSignal.timeout(1500), redirect: 'error' })
        const body = await response.json()
        if (response.ok && body.code === 0 && body.msg === 'ok') {
          const schema = await fetchImpl()(`${url}/openapi.json`, { signal: AbortSignal.timeout(1500), redirect: 'error' })
          const description = await schema.json()
          if (schema.ok && description.info?.title === 'QQMusic API' && description.paths?.['/search/search_by_type']) { state.qqmusicBaseUrl = url; return { ok: true } }
        }
      } catch (_) { /* Wait for startup. */ }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    await stopQqmusicApi()
    return { ok: false, error: 'QQ 音乐 API 未能启动或通过健康检查' }
  }

  async function startInternal() {
    if (state.quitting) return { ok: false, error: '应用正在退出' }
    ensureDataDir()
    if (state.java && !state.java.exited) return { ok: true, alreadyRunning: true, status: buildStatus() }

    // 启动前先探测：公共版没有 bin/ 资源时，这是“正常状态”，直接返回结构化 missing，
    // 不 spawn、不写 [ERROR] 日志、不会出现 “Java 服务异常退出（code=1）”。
    const resources = probeResources()
    if (!resources.ready) return failMissingResources(resources)

    // D-09：没有已保存的非空管理员密码时拒绝启动本地 Java（服务端不能拿空密码当万能钥匙）。
    if (!secrets.isSet('adminPassword')) {
      pushLog('system', '[WARN] 未设置管理员密码，已拒绝启动本地服务')
      return {
        ok: false,
        kind: 'needs-admin-password',
        needsAdminPassword: true,
        error: '首次使用本地服务需要先设置管理员密码（或生成强随机密码）。设置后再启动本地服务。',
        status: buildStatus()
      }
    }

    // D-11：Java 版本兼容性（会 spawn `java -version`，最多 5s 超时）。
    const runtime = await refreshJavaRuntime({ force: true })
    if (state.quitting) return { ok: false, error: '应用正在退出' }
    if (!runtime.compatible || !runtime.found) {
      state.javaStartupError = null
      const message = runtime.version || runtime.lastError
        ? `Java 版本不兼容：${runtime.lastError || describeJavaIncompatible(runtime)}`
        : `Java 版本不兼容：${describeJavaIncompatible(runtime)}`
      pushLog('system', `[ERROR] ${message}`)
      state.lastError = message
      emitStatus()
      return {
        ok: false,
        kind: 'java-incompatible',
        error: message,
        resources: probeResources(),
        logTail: tailLogs(3),
        status: buildStatus()
      }
    }

    state.lastError = null
    state.javaStartupError = null
    const warnings = configWarnings()
    for (const warning of warnings) pushLog('system', `[WARN] ${warning}`)
    pushLog('system', '正在启动本地服务…')

    await ensureNeteaseApi(resources)
    if (state.quitting) { await stopNeteaseApi(); return { ok: false, error: '应用正在退出' } }
    const qq = await startQqmusicApi()
    if (!qq.ok) {
      const warning = `${qq.error || 'QQ 音乐 API 启动失败'}，本次启动将关闭 QQ 音乐音源`
      warnings.push(warning)
      pushLog('system', `[WARN] ${warning}`)
    }
    if (state.quitting) { await stopQqmusicApi(); await stopNeteaseApi(); return { ok: false, error: '应用正在退出' } }

    const args = ['-jar', resources.jarPath, ...buildJavaArgs()]
    const launched = await launchService('java', runtime.path, args, {
      earlyExitWindowMs: SPAWN_EARLY_EXIT_WINDOW_MS
    })
    if (!launched.ok) {
      await stopQqmusicApi()
      await stopNeteaseApi()
      const message = `Java 服务启动失败：${launched.error}`
      state.javaStartupError = launched.error
      return fail(message)
    }

    emitStatus()
    return { ok: true, status: buildStatus(), resources: probeResources(), warnings }
  }

  function start() {
    if (state.quitting) return Promise.resolve({ ok: false, error: '应用正在退出' })
    if (state.clearingPromise) return Promise.resolve({ ok: false, kind: 'clearing', error: '正在清除本地数据，请稍后再启动' })
    if (state.startingPromise) return state.startingPromise
    if (state.stoppingPromise) return state.stoppingPromise.then((result) => result.ok ? start() : result)
    state.startingPromise = startInternal()
      .catch((error) => fail(`启动服务失败：${String((error && error.message) || error)}`))
      .finally(() => {
        state.startingPromise = null
      })
    return state.startingPromise
  }

  async function stopInternal() {
    // A stop during startup must drain startup first, otherwise it can observe no
    // children and return while the pending start later spawns them.
    if (state.startingPromise) await state.startingPromise
    const entries = [state.java, state.netease, state.qqmusic].filter((entry) => entry && !entry.exited)
    state.qqmusicBaseUrl = ''
    if (entries.length === 0) {
      state.java = null
      state.netease = null
      state.qqmusic = null
      state.stopping = false
      stopHealthPoll()
      state.javaReady = false
      return { ok: true, alreadyStopped: true, status: buildStatus() }
    }

    state.stopping = true
    stopHealthPoll()
    state.javaReady = false
    pushLog('system', '正在停止本地服务…')
    const results = await Promise.all(entries.map((entry) => stopEntry(entry)))
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (results[i] && state[entry.name] === entry) state[entry.name] = null
    }
    state.stopping = false
    if (results.some((exited) => !exited)) {
      emitStatus()
      return fail('部分本地服务未能停止，请稍后重试')
    }
    pushLog('system', '本地服务已停止')
    emitStatus()
    return { ok: true, status: buildStatus() }
  }

  function stop() {
    if (state.stoppingPromise) return state.stoppingPromise
    state.stoppingPromise = stopInternal()
      .catch((error) => fail(`停止服务失败：${String((error && error.message) || error)}`))
      .finally(() => {
        state.stopping = false
        state.stoppingPromise = null
      })
    return state.stoppingPromise
  }

  async function restart() {
    pushLog('system', '正在重启本地服务…')
    const stopped = await stop()
    if (!stopped.ok) return stopped
    const started = await start()
    return started.ok ? { ...started, restarted: true } : started
  }

  function clearLocalData() {
    if (state.clearingPromise) return state.clearingPromise
    // Schedule the body after clearingPromise is set: new start calls must be blocked
    // throughout startup drain, process shutdown, file removal and Chromium clearing.
    state.clearingPromise = Promise.resolve().then(async () => {
      if (state.autoStartTimer) { clearTimeout(state.autoStartTimer); state.autoStartTimer = null }
      if (state.startingPromise) await state.startingPromise
      const stopped = await stop()
      if (!stopped.ok) return stopped
      secrets.clearSecrets()
      const root = path.resolve(dataDir())
      for (const name of [CONFIG_FILE_NAME, 'launcher-secrets.json', 'launcher-secrets.json.tmp', 'close-preference.json', 'data', 'cached_media']) {
        const target = path.join(root, name)
        if (path.dirname(target) !== root) throw new Error('Invalid application data path')
        fs.rmSync(target, { recursive: name === 'data' || name === 'cached_media', force: true })
      }
      state.config = { ...DEFAULT_CONFIG }
      state.logs = []
      state.serverInfo = null
      const session = getWindowSafe()?.webContents?.session
      if (session) {
        await session.clearStorageData()
        await session.clearCache()
        if (typeof session.clearAuthCache === 'function') await session.clearAuthCache()
        if (typeof session.clearCodeCaches === 'function') await session.clearCodeCaches({})
      }
      emitStatus()
      return { ok: true }
    }).finally(() => { state.clearingPromise = null })
    return state.clearingPromise
  }

  /* ---------------- 数据目录 ---------------- */

  function electronShell() {
    if (injectedShell) return injectedShell
    try {
      const electron = require('electron')
      if (electron && typeof electron === 'object' && electron.shell) return electron.shell
    } catch (_) {
      /* ignore */
    }
    return null
  }

  async function openDataDir() {
    let dir
    try {
      dir = ensureDataDir()
    } catch (error) {
      return { ok: false, error: `无法创建数据目录：${String((error && error.message) || error)}` }
    }
    const shell = electronShell()
    if (shell && typeof shell.openPath === 'function') {
      try {
        const errorMessage = await shell.openPath(dir)
        if (errorMessage) return { ok: false, error: errorMessage, path: dir }
        return { ok: true, path: dir }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error), path: dir }
      }
    }
    try {
      const command = IS_WINDOWS ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const opener = spawn(command, [dir], { detached: true, stdio: 'ignore' })
      opener.once('error', () => {
        /* ignore */
      })
      opener.unref()
      return { ok: true, path: dir }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error), path: dir }
    }
  }

  /* ---------------- 文件选择 ---------------- */

  function electronDialog() {
    if (injectedDialog) return injectedDialog
    try {
      const electron = require('electron')
      if (electron && typeof electron === 'object' && electron.dialog) return electron.dialog
    } catch (_) {
      /* 纯 Node / smoke：没有 dialog，返回结构化错误即可 */
    }
    return null
  }

  async function pickFile(kind) {
    const spec = PICK_FILE_SPECS[kind]
    if (!spec) return { ok: false, canceled: false, error: '未知的文件类型（仅支持 java / jar）' }
    const dialog = electronDialog()
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      return { ok: false, canceled: false, error: '当前运行环境不支持系统文件选择' }
    }
    const options = { title: spec.title, properties: ['openFile'], filters: spec.filters }
    try {
      const win = getWindowSafe()
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const filePaths = result && Array.isArray(result.filePaths) ? result.filePaths : []
      if (!result || result.canceled || filePaths.length === 0) {
        return { ok: false, canceled: true, kind }
      }
      return { ok: true, canceled: false, kind, path: filePaths[0] }
    } catch (error) {
      return {
        ok: false,
        canceled: false,
        error: `打开文件选择器失败：${String((error && error.message) || error)}`
      }
    }
  }

  /* ---------------- 诊断（脱敏导出） ---------------- */

  /**
   * 诊断快照：供“导出诊断”/排障使用。绝不包含秘密明文（配置脱敏、日志脱敏、
   * 环境变量只报告是否设置，不报告值）。
   */
  function getDiagnostics() {
    const envNames = {}
    for (const key of SECRET_KEYS) envNames[SECRET_ENV_VARS[key]] = secrets.isSet(key)
    return {
      generatedAt: new Date().toISOString(),
      appVersion: (() => {
        try {
          return app.getVersion()
        } catch (_) {
          return ''
        }
      })(),
      platform: process.platform,
      node: process.version,
      dataDir: dataDir(),
      configPath: configFilePath(),
      config: redactedConfig(),
      secretsStorage: secrets.describe(),
      secretEnvNames: envNames,
      javaArgs: buildJavaArgs().map((arg) => sanitizeText(arg)),
      resources: probeResources(),
      status: buildStatus(),
      logs: state.logs.map((entry) => ({ ...entry, line: sanitizeText(entry.line) }))
    }
  }

  /* ---------------- 退出清理 ---------------- */

  function onBeforeQuit(event) {
    if (state.quitComplete) return
    const canDefer = event && typeof event.preventDefault === 'function' && typeof app.quit === 'function'
    if (state.quitting) { if (canDefer) event.preventDefault(); return }
    state.quitting = true
    stopHealthPoll()
    if (state.autoStartTimer) {
      clearTimeout(state.autoStartTimer)
      state.autoStartTimer = null
    }
    if (!canDefer) {
      for (const entry of [state.java, state.netease]) if (entry && !entry.exited) killEntryDetached(entry)
      return
    }
    event.preventDefault()
    const cleanup = state.clearingPromise ? state.clearingPromise.then(result => result.ok ? stop() : result) : stop()
    void cleanup.then((result) => {
      if (!result.ok) {
        state.quitting = false
        pushLog('system', '[ERROR] 本地服务未能完全停止，应用仍在运行，请重试退出')
        emitStatus()
        onQuitFailed('本地服务未能完全停止或本地数据未能清除，应用仍在运行，请重试。')
        return
      }
      state.quitComplete = true
      app.quit()
    }).catch((error) => {
      state.quitting = false
      pushLog('system', `[ERROR] 退出清理失败：${String(error)}`)
      emitStatus()
      onQuitFailed('退出清理失败，应用仍在运行，请重试。')
    })
  }

  /* ---------------- IPC 注册 ---------------- */

  function isTrustedSender(event) {
    return isTrustedRendererFrame(event && event.senderFrame ? event.senderFrame : null)
  }

  function safeHandler(name, handler) {
    return async (...args) => {
      try {
        return await handler(...args)
      } catch (error) {
        const message = sanitizeText(String((error && error.message) || error))
        pushLog('system', `[ERROR] IPC ${name} 处理失败：${message}`)
        return { ok: false, error: message }
      }
    }
  }

  function registerIpc() {
    ipcMain.handle(IPC_CHANNELS.configGet, () => {
      try {
        return redactedConfig()
      } catch (_) {
        return { ...DEFAULT_CONFIG }
      }
    })
    ipcMain.handle(
      IPC_CHANNELS.configSet,
      safeHandler(IPC_CHANNELS.configSet, (_event, patch) => setConfig(patch))
    )
    ipcMain.handle(IPC_CHANNELS.start, safeHandler(IPC_CHANNELS.start, () => start()))
    ipcMain.handle(IPC_CHANNELS.stop, safeHandler(IPC_CHANNELS.stop, () => stop()))
    ipcMain.handle(IPC_CHANNELS.restart, safeHandler(IPC_CHANNELS.restart, () => restart()))
    ipcMain.handle(IPC_CHANNELS.status, safeHandler(IPC_CHANNELS.status, () => buildStatus()))
    ipcMain.handle(IPC_CHANNELS.clearLocalData, safeHandler(IPC_CHANNELS.clearLocalData, async (event) => {
      if (!isTrustedSender(event)) return { ok: false, error: '只允许本机桌面界面清除数据' }
      return clearLocalData()
    }))
    ipcMain.handle(IPC_CHANNELS.openDataDir, safeHandler(IPC_CHANNELS.openDataDir, () => openDataDir()))
    ipcMain.handle(
      IPC_CHANNELS.pickFile,
      safeHandler(IPC_CHANNELS.pickFile, (_event, options) => pickFile(options && options.kind))
    )
    ipcMain.handle(
      IPC_CHANNELS.secretsSet,
      safeHandler(IPC_CHANNELS.secretsSet, (event, patch) => {
        if (!isTrustedSender(event)) return { ok: false, error: '只允许本机桌面界面更新秘密' }
        return setSecrets(patch)
      })
    )
    ipcMain.handle(
      IPC_CHANNELS.secretsClear,
      safeHandler(IPC_CHANNELS.secretsClear, (event, options) => {
        if (!isTrustedSender(event)) return { ok: false, error: '只允许本机桌面界面清除秘密' }
        return clearSecrets(options && options.keys)
      })
    )
    ipcMain.handle(
      IPC_CHANNELS.ensureAdminPassword,
      safeHandler(IPC_CHANNELS.ensureAdminPassword, (event) => {
        if (!isTrustedSender(event)) return { ok: false, error: '只允许本机桌面界面生成管理员密码' }
        return ensureLocalAdminPassword()
      })
    )
    ipcMain.handle(
      IPC_CHANNELS.revealAdminPassword,
      safeHandler(IPC_CHANNELS.revealAdminPassword, (event) => {
        if (!isTrustedSender(event)) return { ok: false, error: '只允许本机桌面界面读取管理员密码' }
        return revealLocalAdminPassword()
      })
    )
  }

  function unregisterIpc() {
    for (const channel of IPC_CHANNEL_LIST) {
      try {
        ipcMain.removeHandler(channel)
      } catch (_) {
        /* ignore */
      }
    }
  }

  /* ---------------- 初始化 ---------------- */

  secrets = createSecretsStore({
    dir: dataDir,
    safeStorage: injectedSafeStorage,
    log: (line) => pushLog('system', line)
  })

  loadConfigAndSecrets()

  if (typeof app.on === 'function') {
    app.on('before-quit', onBeforeQuit)
  }
  registerIpc()
  // 异步探测 Java 版本；状态广播会在探测完成后自动刷新。
  void refreshJavaRuntime()

  if (state.config.autoStart) {
    state.autoStartTimer = setTimeout(() => {
      state.autoStartTimer = null
      if (!state.java) {
        if (!secrets.isSet('adminPassword')) {
          pushLog('system', '[WARN] autoStart 已开启，但没有管理员密码，已跳过自动启动（请先设置管理员密码）')
          return
        }
        pushLog('system', 'autoStart 已开启，自动启动本地服务')
        void start()
      }
    }, AUTO_START_DELAY_MS)
    if (typeof state.autoStartTimer.unref === 'function') state.autoStartTimer.unref()
  }

  /* ---------------- 对外实例 ---------------- */

  self = {
    getConfig: redactedConfig,
    setConfig,
    setSecrets,
    clearSecrets,
    ensureLocalAdminPassword,
    revealLocalAdminPassword,
    start,
    stop,
    restart,
    getStatus: buildStatus,
    clearLocalData,
    isClearingLocalData: () => Boolean(state.clearingPromise),
    /** 强制重新探测 Java 版本（测试/排障用）。 */
    refreshJavaRuntime: (options) => refreshJavaRuntime({ force: true, ...(options || {}) }),
    getLogs: () => state.logs.map((entry) => ({ ...entry })),
    /** 脱敏诊断快照（配置/日志/环境变量名，无秘密明文）。 */
    getDiagnostics,
    /** 资源探测（渲染层通过 status.resources 获取；这里也供主进程/测试直接调用）。 */
    getResources: probeResources,
    pickFile,
    openDataDir,
    dispose
  }

  function dispose() {
    stopHealthPoll()
    if (state.autoStartTimer) {
      clearTimeout(state.autoStartTimer)
      state.autoStartTimer = null
    }
    unregisterIpc()
    if (typeof app.removeListener === 'function') {
      try {
        app.removeListener('before-quit', onBeforeQuit)
      } catch (_) {
        /* ignore */
      }
    }
    if (singleton === self) singleton = null
  }

  return self
}

module.exports = {
  registerLauncher,
  DEFAULT_CONFIG,
  CONFIG_SCHEMA,
  CONFIG_FIELDS,
  SECRET_FIELDS,
  SECRET_KEYS,
  NON_SECRET_SCHEMA,
  CONFIG_FILE_NAME,
  LOG_LIMIT,
  HEALTH_INTERVAL_MS,
  SPAWN_EARLY_EXIT_WINDOW_MS,
  REQUIRED_JAVA_MAJOR,
  EVENT_LOG,
  EVENT_STATUS,
  IPC_CHANNELS,
  analyzeJavaLogLine,
  normalizeConfig
}

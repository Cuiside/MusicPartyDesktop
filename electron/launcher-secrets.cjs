'use strict'

/**
 * MusicParty 启动器 · 秘密存储（D-03）。
 *
 * 设计目标：
 *  - launcher.json 永不包含 adminPassword / neteaseCookie / biliCookie 明文；
 *  - 秘密写入独立文件 `userData/launcher-secrets.json`：
 *      * Electron 可用 `safeStorage.encryptString/decryptString` 时，逐项以
 *        base64 的 OS 加密密文保存（Windows 为 DPAPI，绑定当前用户）；
 *      * safeStorage 不可用（无窗口测试环境、Linux 无 keyring 等）时回退为
 *        “受限权限文件”：文件 chmod 0600，Windows 上尽力用 icacls 收紧到当前用户，
 *        并记录告警 —— 不把该模式称为“加密”。
 *  - 支持从旧 launcher.json 的明文字段一次性迁移（原子写、只记录字段名不记录值）。
 *  - 任何日志/错误信息都不得出现秘密值；本模块只暴露字段名、布尔与能力标记。
 *
 * 本模块不 require('electron')：safeStorage 由调用方注入（生产传 Electron 的
 * safeStorage；测试传 mock），因此可在纯 Node 下运行。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SECRETS_FILE_NAME = 'launcher-secrets.json'
const SECRETS_VERSION = 1
const SECRET_KEYS = Object.freeze(['adminPassword', 'neteaseCookie', 'biliCookie'])

const SECRET_LABELS = Object.freeze({
  adminPassword: '管理员密码',
  neteaseCookie: '网易云 Cookie',
  biliCookie: 'B 站 Cookie'
})

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function writeFileAtomic(file, body, mode) {
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, body, { encoding: 'utf8', mode: mode == null ? 0o600 : mode })
  try {
    fs.renameSync(temp, file)
  } catch (_) {
    // Windows 上目标偶尔被占用：退化为直接覆盖写，并清理临时文件。
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: mode == null ? 0o600 : mode })
    try {
      fs.rmSync(temp, { force: true })
    } catch (_) {
      /* ignore */
    }
  }
  try {
    fs.chmodSync(file, mode == null ? 0o600 : mode)
  } catch (_) {
    /* Windows 上 chmod 语义有限：忽略 */
  }
}

/** Windows 上尽力用 icacls 收紧 ACL（失败只告警，不声称成功）。 */
function tightenWindowsAcl(file) {
  if (process.platform !== 'win32') return { ok: false, skipped: true, reason: 'not-windows' }
  let user = ''
  try {
    user = (os.userInfo().username || '').trim()
  } catch (_) {
    user = ''
  }
  if (!user) return { ok: false, error: '无法获取当前用户名' }
  let domain = ''
  try {
    domain = (process.env.USERDOMAIN || '').trim()
  } catch (_) {
    domain = ''
  }
  const principal = domain ? `${domain}\\${user}` : user
  try {
    const result = spawnSync(
      'icacls',
      [file, '/inheritance:r', '/grant:r', `${principal}:F`],
      { windowsHide: true, stdio: 'ignore', timeout: 5000 }
    )
    if (result && result.status === 0) return { ok: true }
    return { ok: false, error: `icacls 退出码 ${result && result.status}` }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/**
 * 创建秘密存储实例（每个主进程一个）。
 *
 * @param {object} options
 * @param {string} options.dir userData 目录（getter 或字符串均可）
 * @param {object|null} [options.safeStorage] Electron safeStorage（可注入 mock）
 * @param {(line: string) => void} [options.log] 记录告警（不得包含秘密值）
 * @returns {object} 秘密存储实例
 */
function createSecretsStore(options = {}) {
  const dirOption = options.dir
  const safeStorage = options.safeStorage || null
  const log = typeof options.log === 'function' ? options.log : () => {}
  const platform = options.platform || process.platform

  const state = {
    loaded: false,
    values: Object.create(null),
    mode: 'file-permissions',
    encrypted: false,
    warning: null,
    file: '',
    acl: null,
    updatedAt: null
  }

  function storeDir() {
    return typeof dirOption === 'function' ? dirOption() : String(dirOption || '')
  }

  function storeFile() {
    const dir = storeDir()
    if (!dir) throw new Error('缺少秘密存储目录')
    ensureDir(dir)
    return path.join(dir, SECRETS_FILE_NAME)
  }

  function safeStorageUsable() {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return false
    try {
      return Boolean(safeStorage.isEncryptionAvailable())
    } catch (_) {
      return false
    }
  }

  function encryptValue(value) {
    if (!state.encrypted) return { raw: String(value) }
    try {
      const buffer = safeStorage.encryptString(String(value))
      if (!buffer || typeof buffer.toString !== 'function') throw new Error('encryptString 返回非法值')
      return { cipher: Buffer.from(buffer).toString('base64') }
    } catch (error) {
      // 加密失败绝不能退回明文写进“加密”文件：记录告警并丢弃本次写入。
      throw new Error(`safeStorage 加密失败：${String((error && error.message) || error)}`)
    }
  }

  function decryptValue(entry) {
    if (entry == null) return null
    if (!state.encrypted) return typeof entry.raw === 'string' ? entry.raw : null
    try {
      const buffer = Buffer.from(String(entry.cipher || ''), 'base64')
      const text = safeStorage.decryptString(buffer)
      return typeof text === 'string' ? text : null
    } catch (error) {
      log(`[WARN] 无法解密已保存的 ${SECRET_KEYS.length} 类秘密之一（safeStorage 解密失败，可能换了系统用户）；已视为未设置`)
      return null
    }
  }

  function serialize() {
    const entries = Object.create(null)
    for (const key of SECRET_KEYS) {
      const value = state.values[key]
      if (typeof value !== 'string' || value === '') continue
      entries[key] = encryptValue(value)
    }
    const body = {
      version: SECRETS_VERSION,
      mode: state.mode,
      encrypted: state.encrypted,
      warning: state.warning,
      updatedAt: new Date().toISOString(),
      entries
    }
    return `${JSON.stringify(body, null, 2)}\n`
  }

  function tightenPermissions(file) {
    try {
      fs.chmodSync(file, 0o600)
    } catch (_) {
      /* ignore */
    }
    if (platform === 'win32') {
      state.acl = tightenWindowsAcl(file)
    } else {
      state.acl = { ok: true, skipped: false }
    }
    return state.acl
  }

  function persist() {
    const file = storeFile()
    state.file = file
    writeFileAtomic(file, serialize(), 0o600)
    tightenPermissions(file)
    state.updatedAt = new Date().toISOString()
    return file
  }

  function load() {
    if (state.loaded) return state
    state.loaded = true
    state.encrypted = safeStorageUsable()
    state.mode = state.encrypted ? 'safeStorage' : 'file-permissions'
    state.warning = state.encrypted
      ? null
      : '当前环境无法使用 Electron safeStorage：秘密保存在受限权限文件（未加密）；请限制系统账户权限。'
    let raw = null
    try {
      state.file = storeFile()
      raw = readJsonFile(state.file)
    } catch (error) {
      log(`[WARN] 读取秘密存储失败：${String((error && error.message) || error)}（按未设置处理）`)
      return state
    }
    if (!raw || typeof raw !== 'object') return state
    const savedMode = raw.mode === 'safeStorage' ? 'safeStorage' : 'file-permissions'
    if (savedMode !== state.mode) {
      // 文件由另一环境写入：加密文件在 safeStorage 不可用时无法读取（不尝试伪造成功）。
      state.warning = state.encrypted
        ? '秘密文件由未加密环境写入，已按受限权限文件读取。'
        : '秘密文件由 safeStorage 环境加密写入，当前环境无法解密，秘密视为未设置。'
      if (!state.encrypted) state.warning = '秘密文件由 safeStorage 环境加密写入，当前环境无法解密，秘密视为未设置。'
    }
    state.mode = state.encrypted ? 'safeStorage' : 'file-permissions'
    const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {}
    for (const key of SECRET_KEYS) {
      const entry = entries[key]
      if (!entry || typeof entry !== 'object') continue
      const value = decryptValue(entry)
      if (typeof value === 'string' && value !== '') state.values[key] = value
    }
    if (raw.updatedAt) state.updatedAt = String(raw.updatedAt)
    if (!state.acl) tightenPermissions(state.file)
    return state
  }

  function isBlank(value) {
    return typeof value !== 'string' || value.trim() === ''
  }

  /** 秘密的“已设置”状态：空白一律视为未设置。 */
  function isSet(key) {
    load()
    const value = state.values[key]
    return !isBlank(value)
  }

  function get(key) {
    load()
    const value = state.values[key]
    return isBlank(value) ? '' : value
  }

  /**
   * 设置秘密；undefined 表示“不修改”，空白字符串表示“清除该项”。
   * @returns {{changed: string[], configChanged: string[], rejected: string[]}}
   */
  function setSecrets(patch) {
    load()
    const changed = []
    const rejected = []
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { changed, rejected }
    }
    for (const key of SECRET_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
      const raw = patch[key]
      if (raw == null) continue
      if (typeof raw !== 'string') {
        rejected.push(key)
        continue
      }
      const next = raw.trim() === '' ? '' : raw
      const previous = get(key)
      if (next === '') {
        if (previous !== '') {
          delete state.values[key]
          changed.push(key)
        }
        continue
      }
      if (next !== previous) {
        state.values[key] = next
        changed.push(key)
      }
    }
    if (changed.length > 0) persist()
    return { changed, rejected }
  }

  /** 清除全部（或指定 keys）秘密。 */
  function clearSecrets(keys) {
    load()
    const target = Array.isArray(keys) && keys.length > 0 ? keys.filter((key) => SECRET_KEYS.includes(key)) : SECRET_KEYS
    const cleared = []
    for (const key of target) {
      if (state.values[key] !== undefined) {
        delete state.values[key]
        cleared.push(key)
      }
    }
    if (cleared.length > 0) persist()
    return { cleared }
  }

  /**
   * 从旧 launcher.json 的明文配置对象中迁出秘密。
   * 只返回字段名与清理后的对象，不返回/记录秘密值。
   */
  function migrateFromConfig(rawConfig) {
    load()
    const migrated = []
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      return { migrated, config: rawConfig }
    }
    const config = { ...rawConfig }
    for (const key of SECRET_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(config, key)) continue
      const value = config[key]
      delete config[key]
      if (isBlank(value)) continue
      // 秘密存储里已有非空值时不覆盖（secrets 为准），但旧明文仍要被删除。
      if (isBlank(state.values[key])) {
        state.values[key] = String(value)
        migrated.push(key)
      }
    }
    if (migrated.length > 0) {
      persist()
      const labels = migrated.map((key) => SECRET_LABELS[key] || key).join('、')
      log(`已把 ${labels} 从 launcher.json 迁移到安全存储（未记录具体值）`)
    }
    return { migrated, config }
  }

  /** 供 status / getConfig 使用的非敏感能力快照。 */
  function describe() {
    load()
    return {
      file: SECRETS_FILE_NAME,
      mode: state.mode,
      encrypted: Boolean(state.encrypted),
      warning: state.warning,
      aclApplied: state.acl ? Boolean(state.acl.ok) : false,
      set: {
        adminPassword: isSet('adminPassword'),
        neteaseCookie: isSet('neteaseCookie'),
        biliCookie: isSet('biliCookie')
      }
    }
  }

  return {
    load,
    isSet,
    get,
    has: isSet,
    setSecrets,
    clearSecrets,
    migrateFromConfig,
    describe,
    persist,
    get mode() {
      load()
      return state.mode
    },
    get encrypted() {
      load()
      return Boolean(state.encrypted)
    },
    get file() {
      load()
      return state.file || SECRETS_FILE_NAME
    }
  }
}

module.exports = {
  SECRETS_FILE_NAME,
  SECRET_KEYS,
  SECRET_LABELS,
  SECRETS_VERSION,
  createSecretsStore
}

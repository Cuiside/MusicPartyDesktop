'use strict'

/**
 * 真实 Electron 环境下的启动器秘密存储验证（D-03）。
 *
 * 用法（由 scripts/launcher-fix-smoke.cjs 自动调用，也可手动）：
 *   "node_modules/electron/dist/electron.exe" scripts/electron-secrets-smoke.cjs
 *
 * 验证：
 *  - Electron safeStorage 是否可用、模式是否为 safeStorage（不可用则如实报告 file-permissions）；
 *  - setSecrets 后 launcher-secrets.json 不含明文密码/Cookie；
 *  - launcher.json 不含秘密键；
 *  - getConfig 只返回 *Set 布尔与 secretsStorage，不含明文；
 *  - getDiagnostics / 日志不含明文；
 *  - revealLocalAdminPassword 可读回同一密码（内存路径）。
 *
 * 输出一行 `[secrets-e2e] {json}`，退出码 0 表示断言全部通过。
 * 该脚本不创建窗口、不启动 Java，运行后立即 app.exit()。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, ipcMain, safeStorage } = require('electron')

const ROOT = path.resolve(__dirname, '..')
const USER_DATA = process.env.MP_SECRETS_USERDATA || path.join(os.tmpdir(), `mp-secrets-e2e-${process.pid}`)
const FIXTURES = {
  adminPassword: 'electron-e2e-admin-pw-7g4',
  neteaseCookie: 'MUSIC_U=electron-e2e-ncm-3k9',
  biliCookie: 'SESSDATA=electron-e2e-bili-8m2'
}

function emit(payload, code) {
  console.log(`[secrets-e2e] ${JSON.stringify(payload)}`)
  app.exit(code)
}

app.setPath('userData', USER_DATA)

app.whenReady().then(async () => {
  const result = {
    ok: false,
    userData: USER_DATA,
    safeStorageAvailable: false,
    mode: '',
    encrypted: false,
    warning: null,
    plaintextInConfig: true,
    plaintextInSecrets: true,
    configHasSecretKeys: true,
    flagsOk: false,
    diagnosticsLeak: true,
    logsLeak: true,
    revealMatches: false,
    errors: []
  }
  try {
    fs.mkdirSync(USER_DATA, { recursive: true })
    const { registerLauncher } = require(path.join(ROOT, 'electron', 'launcher.cjs'))
    const launcher = registerLauncher({ ipcMain, app, getWindow: () => null, safeStorage })

    try {
      result.safeStorageAvailable = safeStorage.isEncryptionAvailable()
    } catch (_) {
      result.safeStorageAvailable = false
    }

    const setResult = launcher.setSecrets(FIXTURES)
    if (!setResult || setResult.ok !== true) result.errors.push(`setSecrets: ${JSON.stringify(setResult)}`)
    const config = launcher.getConfig()
    result.mode = config.secretsStorage.mode
    result.encrypted = Boolean(config.secretsStorage.encrypted)
    result.warning = config.secretsStorage.warning || null
    result.flagsOk =
      config.adminPasswordSet === true &&
      config.neteaseCookieSet === true &&
      config.biliCookieSet === true &&
      !Object.prototype.hasOwnProperty.call(config, 'adminPassword') &&
      !Object.prototype.hasOwnProperty.call(config, 'neteaseCookie') &&
      !Object.prototype.hasOwnProperty.call(config, 'biliCookie')

    const configFile = path.join(USER_DATA, 'launcher.json')
    const secretsFile = path.join(USER_DATA, 'launcher-secrets.json')
    const configText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
    const secretsText = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile, 'utf8') : ''
    result.plaintextInConfig = Object.values(FIXTURES).some((value) => configText.includes(value))
    result.plaintextInSecrets = Object.values(FIXTURES).some((value) => secretsText.includes(value))
    result.configHasSecretKeys =
      configText.includes('adminPassword') || configText.includes('neteaseCookie') || configText.includes('biliCookie')

    const diagnosticsText = JSON.stringify(launcher.getDiagnostics())
    result.diagnosticsLeak = Object.values(FIXTURES).some((value) => diagnosticsText.includes(value))
    const logsText = JSON.stringify(launcher.getLogs())
    result.logsLeak = Object.values(FIXTURES).some((value) => logsText.includes(value))

    const revealed = launcher.revealLocalAdminPassword()
    result.revealMatches = revealed.ok === true && revealed.password === FIXTURES.adminPassword

    result.ok =
      result.errors.length === 0 &&
      result.encrypted === true &&
      result.mode === 'safeStorage' &&
      !result.plaintextInConfig &&
      !result.plaintextInSecrets &&
      !result.configHasSecretKeys &&
      result.flagsOk &&
      !result.diagnosticsLeak &&
      !result.logsLeak &&
      result.revealMatches
    launcher.dispose()
    emit(result, result.ok ? 0 : 1)
  } catch (error) {
    result.errors.push(String((error && error.stack) || error))
    emit(result, 1)
  }
})

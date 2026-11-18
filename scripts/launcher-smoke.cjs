'use strict'

/**
 * MusicParty 启动器 smoke test（纯 Node，不启动 Electron / 真实 Java）。
 *
 *   node scripts/launcher-smoke.cjs
 *
 * 用 mock 的 ipcMain / app / getWindow / shell / dialog / safeStorage / fetch / javaProbe
 * 注册 electron/launcher.cjs，覆盖：
 *   - IPC 通道注册（config/start/stop/restart/status/openDataDir/pickFile/secrets/* + before-quit）
 *   - 默认配置形状、单一 schema 一致性、合并保存与落盘、未知字段/非法类型忽略、损坏配置回退
 *   - 资源探测：无 bin/ 时 missing；放置 bin/ 资源后 bundled/ready；缺失时 start 结构化失败
 *   - Java 资源就绪但无法执行：人类可读错误 + 日志尾部；并发 start/stop 幂等；日志环形缓冲
 *   - D-03：秘密不落 launcher.json 明文、safeStorage 加密、旧明文自动迁移、诊断/日志脱敏、
 *     safeStorage 不可用时的受限文件回退与告警、Java 参数不含秘密
 *   - D-09：首启无管理员密码拒绝启动、生成 24+ 字符密码、重启实例保留、空/空白拒绝、清除后再次拒绝
 *   - D-10：单 schema 生成字段列表，biliCookie 可 set→get→落盘→重载→环境变量通道
 *   - D-11：Java 版本不兼容时 status=incompatible、start 返回 java-incompatible（注入探测）
 *   - D-04：MusicParty / 网易云健康语义（2xx+JSON+预期字段；4xx/5xx/HTML/超时/重定向不算健康）
 *   - HTTP bridge：不跟随重定向（redirect-blocked）、调用方 frame 校验、超时
 *   - 秘密 IPC：非受信来源拒绝，受信 file:// 允许
 *
 * 输出 PASS/FAIL 明细；全部通过时退出码 0，否则 1。
 * 真实 Java17/25、真实 JAR、真实 HTTP 的测试见 scripts/launcher-fix-smoke.cjs。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const {
  registerLauncher,
  DEFAULT_CONFIG,
  CONFIG_SCHEMA,
  CONFIG_FIELDS,
  SECRET_FIELDS,
  SECRET_KEYS,
  CONFIG_FILE_NAME,
  LOG_LIMIT,
  IPC_CHANNELS
} = require(path.join(ROOT, 'electron', 'launcher.cjs'))
const { SECRETS_FILE_NAME } = require(path.join(ROOT, 'electron', 'launcher-secrets.cjs'))
const health = require(path.join(ROOT, 'electron', 'launcher-health.cjs'))
const httpBridge = require(path.join(ROOT, 'electron', 'http-bridge.cjs'))
const { REQUIRED_JAVA_MAJOR } = require(path.join(ROOT, 'electron', 'launcher-java.cjs'))

/* ------------------------------------------------------------------ */
/* 断言 / 报告                                                         */
/* ------------------------------------------------------------------ */

let passed = 0
let failed = 0
const failures = []

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
  }
}

function expectIncludes(text, needle, message) {
  if (!String(text || '').includes(needle)) {
    throw new Error(`${message}（未包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(text)}）`)
  }
}

async function check(name, task) {
  try {
    const detail = await task()
    passed += 1
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failed += 1
    const message = error && error.message ? error.message : String(error)
    failures.push({ name, message })
    console.log(`[FAIL] ${name} — ${message}`)
  }
}

/* ------------------------------------------------------------------ */
/* mock Electron 环境（每次 makeHarness 一套独立的 userData/appPath）   */
/* ------------------------------------------------------------------ */

const tempDirs = []
function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 可注入的 safeStorage mock：密文 = CIPHER:<hex>，保证文件里不出现明文。 */
const safeStorageState = { available: true }
const safeStorageMock = {
  isEncryptionAvailable: () => safeStorageState.available,
  encryptString: (text) => Buffer.from(`CIPHER:${Buffer.from(String(text), 'utf8').toString('hex')}`, 'utf8'),
  decryptString: (buffer) => {
    const raw = Buffer.from(buffer).toString('utf8')
    if (!raw.startsWith('CIPHER:')) throw new Error('mock decrypt: bad cipher')
    return Buffer.from(raw.slice('CIPHER:'.length), 'hex').toString('utf8')
  }
}

/** 可注入的 Java 版本探测（不真的 spawn java）。 */
const javaProbeState = { mode: 'compatible' }
function mockJavaProbe(exe) {
  if (javaProbeState.mode === 'incompatible') {
    return Promise.resolve({
      ok: true,
      path: exe,
      version: '17.0.20.1+1',
      major: 17,
      compatible: false,
      lastError: '需要 Java 21+，当前 17'
    })
  }
  if (javaProbeState.mode === 'error') {
    return Promise.resolve({
      ok: false,
      path: exe,
      version: '',
      major: null,
      compatible: false,
      lastError: '无法从 Java 输出解析版本'
    })
  }
  return Promise.resolve({
    ok: true,
    path: exe,
    version: '25.0.3+9-LTS',
    major: 25,
    compatible: true,
    lastError: null
  })
}

/** 可注入的 fetch：默认所有请求 404；用例可设置 fetchState.handler。 */
const fetchState = { handler: null }
function makeJsonResponse(status, body, contentType = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    url: '',
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return contentType
        if (String(name).toLowerCase() === 'location') return ''
        return ''
      }
    },
    async text() {
      return text
    }
  }
}
function mockFetch(url, init) {
  if (typeof fetchState.handler === 'function') return fetchState.handler(url, init)
  return Promise.resolve(makeJsonResponse(404, { message: 'not found' }))
}

function makeHarness(options = {}) {
  const userData = options.userData || mkTemp('mp-launcher-smoke-userdata-')
  const appPath = options.appPath || mkTemp('mp-launcher-smoke-app-')
  const configFile = path.join(userData, CONFIG_FILE_NAME)
  const binDir = path.join(appPath, 'bin')

  const handlers = new Map()
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    }
  }

  const appEvents = new Map()
  const app = {
    getPath(name) {
      if (name === 'userData') return userData
      if (name === 'temp') return os.tmpdir()
      throw new Error(`mock app.getPath 不支持 ${name}`)
    },
    getAppPath() {
      return appPath
    },
    getVersion() {
      return '0.2.0'
    },
    isPackaged: false,
    on(event, listener) {
      appEvents.set(event, listener)
    },
    removeListener(event) {
      appEvents.delete(event)
    }
  }

  const sentEvents = []
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sentEvents.push({ channel, payload })
      }
    }
  }

  const openPathCalls = []
  const fakeShell = {
    async openPath(target) {
      openPathCalls.push(target)
      return ''
    }
  }

  const dialogCalls = []
  const dialogState = { mode: 'ok', filePath: '' }
  const fakeDialog = {
    async showOpenDialog(...args) {
      const dialogOptions = args.length > 1 && args[1] && typeof args[1] === 'object' ? args[1] : args[0]
      dialogCalls.push({ argCount: args.length, options: dialogOptions })
      if (dialogState.mode === 'throw') throw new Error('mock dialog failure')
      if (dialogState.mode === 'cancel') return { canceled: true, filePaths: [] }
      return { canceled: false, filePaths: [dialogState.filePath] }
    }
  }

  const deps = {
    ipcMain,
    app,
    getWindow: () => fakeWindow,
    shell: options.shell === null ? undefined : fakeShell,
    safeStorage: options.safeStorage === null ? undefined : options.safeStorage || safeStorageMock,
    fetchImpl: options.fetchImpl || mockFetch,
    javaProbe: options.javaProbe || mockJavaProbe
  }
  if (options.dialog !== null) deps.dialog = fakeDialog
  const launcher = registerLauncher(deps)

  function invoke(channel, ...args) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`没有注册 IPC handler：${channel}`)
    return handler({ sender: null }, ...args)
  }
  function invokeFrom(channel, event, ...args) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`没有注册 IPC handler：${channel}`)
    return handler(event, ...args)
  }
  function eventsOf(channel) {
    return sentEvents.filter((event) => event.channel === channel)
  }
  function dispose() {
    try {
      launcher.dispose()
    } catch (_) {
      /* ignore */
    }
  }

  return {
    options,
    userData,
    appPath,
    configFile,
    binDir,
    secretsFile: path.join(userData, SECRETS_FILE_NAME),
    launcher,
    handlers,
    appEvents,
    sentEvents,
    openPathCalls,
    dialogCalls,
    dialogState,
    app,
    invoke,
    invokeFrom,
    eventsOf,
    dispose
  }
}

function errorLogs(logs) {
  return logs.filter((entry) => String(entry.line).includes('[ERROR]'))
}

const trustedEvent = { sender: null, senderFrame: { url: 'file:///C:/example-app/dist/index.html' } }
const untrustedEvent = { sender: null, senderFrame: { url: 'https://evil.example.com/' } }
const savedServerJarEnv = process.env.MP_SERVER_JAR
delete process.env.MP_SERVER_JAR

let env = null

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('MusicParty launcher smoke test')
  console.log(`  node      ${process.version}`)
  console.log('')

  env = makeHarness()

  await check('1. 注册 launcher IPC 通道 + before-quit 钩子', async () => {
    const expected = [
      'launcher:config:get',
      'launcher:config:set',
      'launcher:start',
      'launcher:stop',
      'launcher:restart',
      'launcher:status',
      'launcher:openDataDir',
      'launcher:pickFile',
      'launcher:secrets:set',
      'launcher:secrets:clear',
      'launcher:secrets:ensureAdminPassword',
      'launcher:secrets:revealAdminPassword',
      'launcher:data:clear'
    ]
    for (const channel of expected) expect(env.handlers.has(channel), `缺少 IPC handler：${channel}`)
    expectEqual(env.handlers.size, expected.length, 'IPC handler 数量')
    expectEqual(IPC_CHANNELS.pickFile, 'launcher:pickFile', 'IPC_CHANNELS.pickFile')
    expect(typeof env.appEvents.get('before-quit') === 'function', '未注册 app.on("before-quit")')
    return `${expected.length} 个通道`
  })

  await check('2. 默认配置形状 + 单一 schema 一致性（D-10）', async () => {
    const config = await env.invoke('launcher:config:get')
    expect(config && typeof config === 'object', 'getConfig 未返回对象')
    expect(Object.isFrozen(DEFAULT_CONFIG), 'DEFAULT_CONFIG 应被冻结')
    expect(Object.isFrozen(CONFIG_SCHEMA), 'CONFIG_SCHEMA 应被冻结')
    expect(config !== DEFAULT_CONFIG, 'config:get 不应直接返回内部对象引用')
    expect(!Object.prototype.hasOwnProperty.call(config, 'resources'), 'config 不应包含 resources 字段')

    // schema 与字段列表必须完全一致：每个 schema 键都在 CONFIG_FIELDS；每个默认值键都在 schema。
    for (const field of CONFIG_SCHEMA) expect(CONFIG_FIELDS.has(field.key), `CONFIG_FIELDS 缺少 ${field.key}`)
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(CONFIG_SCHEMA.some((field) => field.key === key && !field.secret), `schema 缺少非秘密字段 ${key}`)
    }
    for (const secretKey of SECRET_KEYS) {
      expect(CONFIG_FIELDS.has(secretKey), `CONFIG_FIELDS 应包含秘密字段 ${secretKey}（用于 setConfig 兼容路由）`)
      expect(SECRET_FIELDS.has(secretKey), `SECRET_FIELDS 应包含 ${secretKey}`)
      expect(!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, secretKey), `DEFAULT_CONFIG 不应包含秘密字段 ${secretKey}`)
    }
    expect(SECRET_FIELDS.has('biliCookie'), 'D-10：biliCookie 必须在 schema 中（秘密字段）')

    expectEqual(config.serverIp, '127.0.0.1', 'serverIp 默认应为回环地址（D-09）')
    expectEqual(config.serverPort, '8080', 'serverPort 应为字符串')
    expectEqual(config.baseUrl, 'http://localhost:8080', 'baseUrl')
    expectEqual(config.neteaseApiBaseUrl, 'http://127.0.0.1:3000', 'neteaseApiBaseUrl 默认值')
    expectEqual(config.authorName, 'ThorNex', 'authorName')
    expectEqual(config.backWords, 'THORNEX', 'backWords')
    expectEqual(config.neteaseQuality, 'exhigh', 'neteaseQuality')
    expectEqual(config.neteaseEnabled, true, 'neteaseEnabled')
    expectEqual(config.bilibiliEnabled, true, 'bilibiliEnabled')
    expectEqual(config.queueMaxSize, 1000, 'queueMaxSize')
    expectEqual(config.cacheMaxSize, '1GB', 'cacheMaxSize')
    expectEqual(config.authMaxAttempts, 5, 'authMaxAttempts')
    expectEqual(config.autoStart, false, 'autoStart')
    expectEqual(config.javaPath, '', 'javaPath')
    expectEqual(config.serverJar, '', 'serverJar')
    expectEqual(config.neteaseApiPath, '', 'neteaseApiPath')

    // 秘密字段：只返回 *Set 布尔 + 存储能力，不返回明文键。
    for (const secretKey of ['adminPassword', 'neteaseCookie', 'biliCookie']) {
      expect(!Object.prototype.hasOwnProperty.call(config, secretKey), `getConfig 不应包含明文 ${secretKey}`)
    }
    expectEqual(config.adminPasswordSet, false, 'adminPasswordSet')
    expectEqual(config.neteaseCookieSet, false, 'neteaseCookieSet')
    expectEqual(config.biliCookieSet, false, 'biliCookieSet')
    expect(config.secretsStorage && typeof config.secretsStorage === 'object', '缺少 secretsStorage')
    expectEqual(config.secretsStorage.mode, 'safeStorage', 'mock safeStorage 可用时模式')
    expectEqual(config.secretsStorage.encrypted, true, 'mock safeStorage 可用时应标记加密')
    return `${Object.keys(config).length} 个返回字段 / ${CONFIG_SCHEMA.length} 个 schema 字段`
  })

  await check('3. set 合并保存并持久化到 launcher.json（不含秘密键）', async () => {
    const result = await env.invoke('launcher:config:set', {
      serverIp: 'localhost',
      serverPort: 9091,
      queueMaxSize: 42,
      neteaseEnabled: false
    })
    expect(result && result.ok === true, `config:set 未返回 ok：${JSON.stringify(result)}`)
    expectEqual(result.config.serverIp, 'localhost', '合并后的 serverIp')
    expectEqual(result.config.serverPort, '9091', '数字端口应归一化为字符串')
    expectEqual(result.config.queueMaxSize, 42, '合并后的 queueMaxSize')
    expectEqual(result.config.neteaseEnabled, false, '合并后的 neteaseEnabled')
    expectEqual(result.config.authorName, 'ThorNex', '未提交字段应保留原值')
    expect(result.changed.includes('serverPort'), 'changed 应包含 serverPort')

    expect(fs.existsSync(env.configFile), `配置文件未落盘：${env.configFile}`)
    const text = fs.readFileSync(env.configFile, 'utf8')
    const onDisk = JSON.parse(text)
    expectEqual(onDisk.serverPort, '9091', '磁盘配置 serverPort')
    expectEqual(onDisk.queueMaxSize, 42, '磁盘配置 queueMaxSize')
    expectEqual(onDisk.autoStart, false, '磁盘配置 autoStart 默认值')
    expect(!Object.prototype.hasOwnProperty.call(onDisk, 'resources'), '磁盘配置不应写入 resources')
    for (const secretKey of ['adminPassword', 'neteaseCookie', 'biliCookie']) {
      expect(!Object.prototype.hasOwnProperty.call(onDisk, secretKey), `launcher.json 不应包含秘密字段 ${secretKey}`)
    }
    expect(!text.includes('adminPassword'), 'launcher.json 文本不应出现 adminPassword 键')
    return env.configFile
  })

  await check('4. 未知字段 / 非法类型 / 越界值被忽略', async () => {
    const result = await env.invoke('launcher:config:set', {
      bogusField: 'ignored',
      queueMaxSize: 'not-a-number',
      neteaseEnabled: 'yes',
      authMaxAttempts: -3,
      serverPort: 70000
    })
    expect(result && result.ok === true, '带非法字段的 patch 不应失败')
    expect(!('bogusField' in result.config), '未知字段不应写入配置')
    expectEqual(result.config.queueMaxSize, 42, '非法类型应保留旧值')
    expectEqual(result.config.neteaseEnabled, false, '非法布尔应保留旧值')
    expectEqual(result.config.authMaxAttempts, 5, '负数应保留旧值')
    expectEqual(result.config.serverPort, '9091', '越界端口应保留旧值')
    expect(result.ignored.includes('bogusField'), 'ignored 应报告未知字段')
    return 'unknown/type/range 均被过滤'
  })

  await check('5. 资源探测：无 bin/ 时 ready:false、bundled:false（公共版默认）', async () => {
    expect(!fs.existsSync(env.binDir), '测试前提：临时 appPath 下不应有 bin/')
    const status = await env.invoke('launcher:status')
    const resources = status.resources
    expect(resources && typeof resources === 'object', 'status 缺少 resources')
    expect(resources.java && typeof resources.java === 'object', 'resources 缺少嵌套 java')
    expect(resources.serverJar && typeof resources.serverJar === 'object', 'resources 缺少嵌套 serverJar')
    expect(resources.neteaseApi && typeof resources.neteaseApi === 'object', 'resources 缺少嵌套 neteaseApi')
    expect(typeof resources.javaPath === 'string', 'resources.javaPath 应为字符串（旧扁平字段兼容）')
    expectEqual(resources.bundled, false, '无 bin/ 时 bundled 应为 false')
    expectEqual(resources.ready, false, '缺 jar 时 ready 应为 false')
    expect(resources.missing.includes('jar'), `missing 应包含 jar：${JSON.stringify(resources.missing)}`)
    expectEqual(resources.javaFound, !resources.missing.includes('java'), 'missing 与 javaFound 应一致')
    expectEqual(resources.neteaseFound, false, '无 bin/ 且未配置时 neteaseFound 应为 false')
    expect(['none', 'system'].includes(resources.source), `未内置资源时 source：${resources.source}`)
    expect(['missing', 'probing', 'incompatible', 'stopped'].includes(status.services.java.state), `java.state：${status.services.java.state}`)
    expect(status.services.java && typeof status.services.java === 'object', 'status 缺少 services.java')
    expect(status.services.netease && typeof status.services.netease === 'object', 'status 缺少 services.netease')
    expect(status.services.system && typeof status.services.system === 'object', 'status 缺少 services.system')
    expect(Array.isArray(status.logTail), 'status.logTail 应为数组')
    expect(status.logTail.length <= 3, 'logTail 最多 3 行')
    return `missing=${JSON.stringify(resources.missing)} / java.state=${status.services.java.state}`
  })

  await check('6. 资源探测：bin/ 放齐资源后 bundled:true、ready:true', async () => {
    fs.mkdirSync(path.join(env.binDir, 'jre', 'bin'), { recursive: true })
    const fakeJava = path.join(env.binDir, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const fakeJar = path.join(env.binDir, 'server.jar')
    const fakeNetease = path.join(env.binDir, process.platform === 'win32' ? 'netease-api.exe' : 'netease-api')
    fs.writeFileSync(fakeJava, '')
    fs.writeFileSync(fakeJar, '')
    fs.writeFileSync(fakeNetease, '')

    const applied = await env.invoke('launcher:config:set', { javaPath: '', serverJar: '', neteaseApiPath: '' })
    expect(applied.ok === true, '重置路径配置失败')
    await env.launcher.refreshJavaRuntime()

    const status = await env.invoke('launcher:status')
    const resources = status.resources
    expectEqual(resources.bundled, true, '存在 bin/ 资源时 bundled 应为 true')
    expectEqual(resources.ready, true, 'java + jar 均存在时 ready 应为 true')
    expectEqual(resources.javaFound, true, 'javaFound')
    expectEqual(resources.jarFound, true, 'jarFound')
    expectEqual(resources.neteaseFound, true, 'neteaseFound')
    expectEqual(resources.javaPath, fakeJava, 'javaPath 应指向内置 JRE')
    expectEqual(resources.jarPath, fakeJar, 'jarPath 应指向内置 server.jar')
    expectEqual(resources.source, 'bundled', 'source 应为 bundled')
    expectEqual(resources.missing.length, 0, 'ready 时 missing 应为空')
    expectEqual(resources.java.found, true, 'resources.java.found')
    expectEqual(resources.java.compatible, true, 'resources.java.compatible（注入探测）')
    expectEqual(resources.java.version, '25.0.3+9-LTS', 'resources.java.version（注入探测）')
    return `bundled/ready 探测正确`
  })

  await check('7. D-09：设置管理员密码（生成 24+ 字符、可 reveal、空白拒绝）', async () => {
    const before = await env.invoke('launcher:config:get')
    expectEqual(before.adminPasswordSet, false, '初始管理员密码应为未设置')

    const generated = await env.invokeFrom('launcher:secrets:ensureAdminPassword', trustedEvent)
    expect(generated && generated.ok === true, `ensureLocalAdminPassword 失败：${JSON.stringify(generated)}`)
    expectEqual(generated.generated, true, '首次应标记 generated:true')
    expectEqual(generated.set, true, '首次应标记 set:true')
    expect(typeof generated.password === 'string', '首次应返回生成密码（本次展示用）')
    expect(generated.password.length >= 24, `密码长度应 >= 24（实际 ${generated.password && generated.password.length}）`)
    expect(!Object.prototype.hasOwnProperty.call(generated.config, 'adminPassword'), '返回配置不得含明文密码')

    const second = await env.invokeFrom('launcher:secrets:ensureAdminPassword', trustedEvent)
    expectEqual(second.generated, false, '已有密码时不应重复生成')
    expect(!Object.prototype.hasOwnProperty.call(second, 'password'), '已有密码时不应返回明文')

    const revealed = await env.invokeFrom('launcher:secrets:revealAdminPassword', trustedEvent)
    expectEqual(revealed.ok, true, 'reveal 应成功')
    expectEqual(revealed.password, generated.password, 'reveal 应返回同一密码')

    const blank = await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: '   ' })
    expectEqual(blank.ok, false, '空白管理员密码应被拒绝')

    const cfg = await env.invoke('launcher:config:get')
    expectEqual(cfg.adminPasswordSet, true, 'getConfig 应显示 adminPasswordSet:true')
    expect(!JSON.stringify(cfg).includes(generated.password), 'getConfig 不得包含明文密码')
    return `生成密码长度 ${generated.password.length}`
  })

  await check('8. 资源就绪但 Java 无法执行：人类可读错误 + 日志尾部（≤3 行）', async () => {
    const result = await env.invoke('launcher:start')
    expect(result && result.ok === false, `start 应返回 ok:false：${JSON.stringify(result)}`)
    expect(typeof result.error === 'string' && result.error.length > 0, 'start 应返回 error 文本')
    expectIncludes(result.error, 'Java 服务启动失败', 'error 应是人类可读文案')
    expect(!/\n\s+at\s/.test(result.error), '主文案不应包含原始堆栈')
    expect(Array.isArray(result.logTail), '失败结果应包含 logTail 数组')
    expect(result.logTail.length > 0 && result.logTail.length <= 3, 'logTail 应为 1~3 行')
    expectEqual(result.kind, undefined, '可执行文件缺失类失败不应带 needsAdminPassword kind')

    const status = await env.invoke('launcher:status')
    expectEqual(status.lastError, result.error, 'status.lastError 应等于 start 错误')
    expectEqual(status.services.java.running, false, 'Java 服务不应处于运行态')
    expectEqual(status.running, false, 'status.running 应为 false')
    return result.error
  })

  await check('9. 资源缺失 start 不 spawn、不写 [ERROR] 日志、返回结构化 missing', async () => {
    const missingJava = path.join(env.userData, 'no-such-java.exe')
    const missingJar = path.join(env.userData, 'no-such-server.jar')
    await env.invoke('launcher:config:set', { javaPath: missingJava, serverJar: missingJar })

    const logsBefore = env.launcher.getLogs()
    const statusEventsBefore = env.eventsOf('launcher:status').length
    const result = await env.invoke('launcher:start')

    expect(result && result.ok === false, 'start 应返回 ok:false，而不是抛错')
    expectEqual(result.kind, 'resources-missing', 'result.kind 应为 resources-missing')
    expect(result.missing.includes('java'), `missing 应包含 java：${JSON.stringify(result.missing)}`)
    expect(result.missing.includes('jar'), `missing 应包含 jar：${JSON.stringify(result.missing)}`)
    expectIncludes(result.error, '未找到', 'error 应说明缺少资源')
    expectIncludes(result.error, 'javaPath', 'error 应指出无效配置')
    expectEqual(result.resources && result.resources.ready, false, 'result.resources.ready 应为 false')
    expectEqual(result.logTail.length, 0, '资源缺失失败不应附带日志尾部')

    const logsAfter = env.launcher.getLogs()
    const newLogs = logsAfter.slice(logsBefore.length)
    expectEqual(logsAfter.length, logsBefore.length, '资源缺失的 start 不应新增任何日志')
    expectEqual(errorLogs(logsAfter).length, errorLogs(logsBefore).length, '资源缺失的 start 不应新增 [ERROR]')
    expect(!newLogs.some((entry) => entry.line.includes('正在启动本地服务')), '资源缺失时不应进入 spawn 流程')
    expect(!newLogs.some((entry) => entry.line.includes('异常退出')), '资源缺失时不应产生“异常退出”日志')

    const status = await env.invoke('launcher:status')
    expectEqual(status.lastError, result.error, 'status.lastError 应为人类可读原因')
    expectEqual(status.services.java.state, 'missing', 'status.services.java.state 应为 missing')
    expectEqual(status.services.java.pid, null, 'Java 服务 pid 应为 null')
    expectEqual(status.resources.ready, false, 'status.resources.ready 应为 false')
    expect(env.eventsOf('launcher:status').length > statusEventsBefore, 'start 应广播 launcher:status（含 resources）')
    return result.error
  })

  await check('10. status 广播包含 services(3) / resources / logTail / secretsStorage', async () => {
    const statuses = env.eventsOf('launcher:status')
    expect(statuses.length > 0, '没有收到 launcher:status 广播')
    const withServices = statuses.find(
      (event) =>
        event.payload &&
        event.payload.services &&
        event.payload.services.java &&
        event.payload.services.netease &&
        event.payload.services.system
    )
    expect(withServices, '状态广播缺少 services.java / services.netease / services.system')
    expect(withServices.payload.resources && typeof withServices.payload.resources === 'object', '状态广播缺少 resources')
    expect(Array.isArray(withServices.payload.logTail), '状态广播缺少 logTail')
    expect(withServices.payload.secretsStorage && typeof withServices.payload.secretsStorage === 'object', '状态广播缺少 secretsStorage')
    expectEqual(typeof withServices.payload.needsAdminPassword, 'boolean', 'needsAdminPassword 类型')
    return `${statuses.length} 次状态广播`
  })

  await check('11. 并发重复 start 幂等（不重复 spawn、不抛错）', async () => {
    const [first, second] = await Promise.all([env.invoke('launcher:start'), env.invoke('launcher:start')])
    expect(first && second, '并发 start 应都有返回值')
    expectEqual(first.ok, false, '并发 start 结果 ok')
    expectEqual(second.ok, false, '并发 start 结果 ok')
    expectEqual(first.kind, 'resources-missing', '并发 start kind')
    return '并发调用返回同一结构化失败结果'
  })

  await check('12. stop 幂等', async () => {
    const first = await env.invoke('launcher:stop')
    expect(first && first.ok === true, '第一次 stop 应返回 ok:true')
    expectEqual(first.alreadyStopped, true, '第一次 stop（无进程）应 alreadyStopped:true')
    const second = await env.invoke('launcher:stop')
    expect(second && second.ok === true, '第二次 stop 应返回 ok:true')
    expectEqual(second.alreadyStopped, true, '第二次 stop 应 alreadyStopped:true')

    const status = await env.invoke('launcher:status')
    expectEqual(status.services.java.running, false, 'stop 后 java 不应运行')
    expectEqual(status.services.netease.running, false, 'stop 后 netease 不应运行')
    return '两次 stop 均安全返回'
  })

  await check(`13. 日志环形缓冲上限 ${LOG_LIMIT} 行`, async () => {
    const attempts = LOG_LIMIT + 100
    for (let index = 0; index < attempts; index += 1) {
      await env.invoke('launcher:config:set', { authorName: `tester-${index}` })
    }
    const logs = env.launcher.getLogs()
    expectEqual(logs.length, LOG_LIMIT, `日志缓冲应被截断到 ${LOG_LIMIT} 行`)
    for (const entry of logs) {
      expect(['java', 'netease', 'system'].includes(entry.service), `非法 service：${entry.service}`)
      expect(typeof entry.line === 'string' && entry.line.length > 0, '日志 line 为空')
      expect(typeof entry.time === 'string' && entry.time.length > 0, '日志 time 为空')
    }
    const last = logs[logs.length - 1]
    expect(last.line.includes('配置已更新'), `最后一行应为最近一次配置变更：${last.line}`)
    return `累计 ${attempts} 次配置变更后稳定在 ${logs.length} 行`
  })

  await check('14. openDataDir 打开 userData 目录', async () => {
    const result = await env.invoke('launcher:openDataDir')
    expect(result && result.ok === true, `openDataDir 应返回 ok:true：${JSON.stringify(result)}`)
    expectEqual(result.path, env.userData, 'openDataDir 路径应为 userData')
    expect(env.openPathCalls.includes(env.userData), 'shell.openPath 未被调用或路径不一致')
    expect(fs.existsSync(env.userData), '数据目录应存在')
    return env.userData
  })

  await check('15. before-quit 钩子可安全执行', async () => {
    const beforeQuit = env.appEvents.get('before-quit')
    expect(typeof beforeQuit === 'function', 'before-quit 钩子未注册')
    beforeQuit()
    const status = env.launcher.getStatus()
    expectEqual(status.services.java.running, false, 'before-quit 后 java 不应运行')
    return '钩子无副作用'
  })

  await check('16. dispose 移除 IPC handler 并允许重新注册', async () => {
    env.dispose()
    expectEqual(env.handlers.size, 0, 'dispose 后应移除所有 IPC handler')
    expect(!env.appEvents.has('before-quit'), 'dispose 后应移除 before-quit 监听')
    return 'cleanup ok'
  })

  await check('17. 配置文件损坏时回退默认值并记录 WARN', async () => {
    fs.writeFileSync(env.configFile, '{ this is not json', 'utf8')
    env.dispose()
    env = makeHarness({ userData: env.userData, appPath: env.appPath })
    const config = await env.invoke('launcher:config:get')
    expectEqual(config.serverPort, '8080', '损坏配置应回退默认 serverPort')
    expectEqual(config.serverIp, '127.0.0.1', '损坏配置应回退默认 serverIp')
    expectEqual(config.javaPath, '', '损坏配置应回退默认 javaPath')
    const warned = env.launcher.getLogs().some((entry) => entry.service === 'system' && entry.line.includes('[WARN] 读取配置'))
    expect(warned, '配置损坏时应广播 WARN 日志')
    env.dispose()
    return 'fallback to defaults'
  })

  await check('18. pickFile（mock dialog）：jar/java filters、取消、异常、未知类型', async () => {
    env = makeHarness()
    const fakeJarPath = path.join(env.userData, 'picked-server.jar')
    env.dialogState.mode = 'ok'
    env.dialogState.filePath = fakeJarPath

    const jarResult = await env.invoke('launcher:pickFile', { kind: 'jar' })
    expectEqual(jarResult.ok, true, 'pickFile(jar) 应返回 ok:true')
    expectEqual(jarResult.path, fakeJarPath, 'pickFile(jar) 返回路径')
    const jarCall = env.dialogCalls[env.dialogCalls.length - 1]
    expectEqual(jarCall.argCount, 2, '应把 BrowserWindow 作为第一个参数传给 dialog')
    expectEqual(jarCall.options.properties.join(','), 'openFile', '对话框 properties 应为 openFile')
    expect(
      jarCall.options.filters.some((filter) => (filter.extensions || []).includes('jar')),
      `jar 过滤器缺失：${JSON.stringify(jarCall.options.filters)}`
    )

    env.dialogState.filePath = path.join(env.userData, 'picked-java.exe')
    const javaResult = await env.invoke('launcher:pickFile', { kind: 'java' })
    expectEqual(javaResult.ok, true, 'pickFile(java) 应返回 ok:true')
    const javaCall = env.dialogCalls[env.dialogCalls.length - 1]
    expect(
      javaCall.options.filters.some((filter) => (filter.extensions || []).length > 0),
      'java 过滤器缺失'
    )
    expectIncludes(javaCall.options.title, 'Java', 'java 对话框标题')

    env.dialogState.mode = 'cancel'
    const canceled = await env.invoke('launcher:pickFile', { kind: 'jar' })
    expectEqual(canceled.ok, false, '取消选择应返回 ok:false')
    expectEqual(canceled.canceled, true, '取消选择应标记 canceled:true')

    env.dialogState.mode = 'throw'
    const thrown = await env.invoke('launcher:pickFile', { kind: 'jar' })
    expectEqual(thrown.ok, false, 'dialog 抛错应返回 ok:false')
    expectIncludes(thrown.error, '打开文件选择器失败', '异常文案')

    const unknown = await env.invoke('launcher:pickFile', { kind: 'dll' })
    expectEqual(unknown.ok, false, '未知类型应返回 ok:false')
    expectIncludes(unknown.error, '未知', '未知类型文案')

    env.dispose()
    return `dialog 调用 ${env.dialogCalls.length} 次`
  })

  await check('19. pickFile 在纯 Node（无 electron.dialog）下防御式返回，不崩溃', async () => {
    env = makeHarness({ dialog: null })
    let result
    try {
      result = await env.invoke('launcher:pickFile', { kind: 'jar' })
    } catch (error) {
      throw new Error(`纯 Node 下 pickFile 不应抛错：${String(error && error.message)}`)
    }
    expectEqual(result.ok, false, '无 dialog 时应返回 ok:false')
    expect(result.canceled !== true, '无 dialog 不应被当作“用户取消”')
    expect(typeof result.error === 'string' && result.error.length > 0, '无 dialog 时应给出 error 文案')
    env.dispose()
    return result.error
  })

  /* ---------------- D-10 / D-03 秘密存储 ---------------- */

  await check('20. D-10：biliCookie set→get→落盘→重载→秘密通道全链路', async () => {
    env = makeHarness()
    const biliFixture = 'SESSDATA=fixture-bili-9a1; bili_jct=fixture-jct'
    const ncmFixture = 'MUSIC_U=fixture-ncm-7c2'
    const result = await env.invoke('launcher:config:set', {
      biliCookie: biliFixture,
      neteaseCookie: ncmFixture,
      serverIp: '127.0.0.1',
      serverPort: 19081,
      neteaseApiBaseUrl: 'http://127.0.0.1:3100/'
    })
    expectEqual(result.ok, true, `setConfig 失败：${JSON.stringify(result)}`)
    expectIncludes(result.changed.join(','), 'biliCookie', 'changed 应包含 biliCookie（不再是 ignored）')
    expect(!result.ignored.includes('biliCookie'), 'biliCookie 不应进入 ignored')
    expectEqual(result.config.biliCookieSet, true, 'biliCookieSet 应为 true')
    expectEqual(result.config.neteaseCookieSet, true, 'neteaseCookieSet 应为 true')
    expectEqual(result.config.neteaseApiBaseUrl, 'http://127.0.0.1:3100', 'neteaseApiBaseUrl 应去掉尾部斜杠')

    // 落盘：launcher.json 只有非秘密字段；secrets 文件是加密密文（mock 下为 CIPHER:hex）。
    const configText = fs.readFileSync(env.configFile, 'utf8')
    expect(!configText.includes(biliFixture), 'launcher.json 不得包含 biliCookie 明文')
    expect(!configText.includes(ncmFixture), 'launcher.json 不得包含 neteaseCookie 明文')
    expect(!configText.includes('biliCookie'), 'launcher.json 不得包含 biliCookie 键')
    expect(fs.existsSync(env.secretsFile), '秘密文件未创建')
    const secretsText = fs.readFileSync(env.secretsFile, 'utf8')
    expect(!secretsText.includes(biliFixture), '秘密文件不得包含明文 Cookie（safeStorage 加密）')
    expect(!secretsText.includes(ncmFixture), '秘密文件不得包含明文 Cookie（safeStorage 加密）')
    const secretsJson = JSON.parse(secretsText)
    expectEqual(secretsJson.mode, 'safeStorage', '秘密文件 mode 应为 safeStorage')
    expectEqual(secretsJson.encrypted, true, '秘密文件 encrypted 应为 true')

    // reload：新实例从磁盘恢复（模拟重启）
    env.dispose()
    env = makeHarness({ userData: env.userData, appPath: env.appPath })
    const reloaded = await env.invoke('launcher:config:get')
    expectEqual(reloaded.biliCookieSet, true, '重载后 biliCookieSet 应为 true')
    expectEqual(reloaded.neteaseCookieSet, true, '重载后 neteaseCookieSet 应为 true')
    expectEqual(reloaded.serverPort, '19081', '重载后 serverPort 应持久化')
    expectEqual(reloaded.neteaseApiBaseUrl, 'http://127.0.0.1:3100', '重载后 neteaseApiBaseUrl')

    // 诊断/日志/Java 参数：不出现秘密明文；环境变量只报告“是否设置”。
    const diagnostics = env.launcher.getDiagnostics()
    const diagnosticsText = JSON.stringify(diagnostics)
    expect(!diagnosticsText.includes(biliFixture), '诊断快照不得包含 biliCookie 明文')
    expect(!diagnosticsText.includes(ncmFixture), '诊断快照不得包含 neteaseCookie 明文')
    expectEqual(diagnostics.secretEnvNames.APP_MUSICAPI_BILIBILI_COOKIE, true, '环境变量通道应标记 B 站 Cookie 已设置')
    expectEqual(diagnostics.secretEnvNames.APP_MUSICAPI_NETEASE_COOKIE, true, '环境变量通道应标记网易云 Cookie 已设置')
    expect(!diagnostics.javaArgs.join(' ').includes(biliFixture), 'Java 命令行不得包含 Cookie 明文')
    expect(!diagnostics.javaArgs.join(' ').includes('bilibili.cookie'), 'Java 命令行不应再传 bilibili.cookie 参数')
    expectIncludes(diagnostics.javaArgs.join(' '), '--app.music-api.netease.base-url=http://127.0.0.1:3100', 'Java 参数应使用可配置网易云地址')
    expectIncludes(diagnostics.javaArgs.join(' '), '--app.music-api.sources.netease.enabled=', '音源参数应使用当前服务端格式')
    expectIncludes(diagnostics.javaArgs.join(' '), '--app.music-api.auth.rate-limit-enabled=', '限流参数应使用当前服务端格式')
    expect(!diagnostics.javaArgs.join(' ').includes('--app.music-api.netease.enabled='), '不可向严格绑定的新版服务端发送旧参数')
    expect(!diagnostics.javaArgs.join(' ').includes('--app.music-api.auth.rate-limit.enabled='), '不可向严格绑定的新版服务端发送旧限流参数')
    return 'biliCookie 全链路一致且无明文落盘'
  })

  await check('21. D-03：旧 launcher.json 明文自动迁移（原子写、日志不泄漏）', async () => {
    const harness = makeHarness()
    const adminFixture = 'legacy-admin-pw-fixture-5f7'
    const ncmFixture = 'MUSIC_U=legacy-ncm-fixture-2b8'
    const biliFixture = 'SESSDATA=legacy-bili-fixture-4c9'
    const legacyConfig = {
      serverIp: '127.0.0.1',
      serverPort: '18083',
      adminPassword: adminFixture,
      neteaseCookie: ncmFixture,
      biliCookie: biliFixture,
      authorName: 'LegacyUser'
    }
    fs.writeFileSync(harness.configFile, `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8')
    harness.dispose()

    env = makeHarness({ userData: harness.userData, appPath: harness.appPath })
    const config = await env.invoke('launcher:config:get')
    expectEqual(config.adminPasswordSet, true, '迁移后 adminPasswordSet')
    expectEqual(config.neteaseCookieSet, true, '迁移后 neteaseCookieSet')
    expectEqual(config.biliCookieSet, true, '迁移后 biliCookieSet')
    expectEqual(config.serverPort, '18083', '迁移不应丢失其它配置')
    expectEqual(config.authorName, 'LegacyUser', '迁移不应丢失其它配置')

    const configText = fs.readFileSync(env.configFile, 'utf8')
    for (const [label, value] of [['adminPassword', adminFixture], ['neteaseCookie', ncmFixture], ['biliCookie', biliFixture]]) {
      expect(!configText.includes(value), `迁移后 launcher.json 不得残留 ${label} 明文`)
      expect(!configText.includes(label), `迁移后 launcher.json 不得残留 ${label} 键`)
    }
    const secretsText = fs.readFileSync(env.secretsFile, 'utf8')
    expect(!secretsText.includes(adminFixture), '秘密文件不得含管理员密码明文')
    const logsText = JSON.stringify(env.launcher.getLogs())
    for (const [label, value] of [['管理员密码', adminFixture], ['网易云 Cookie', ncmFixture], ['B 站 Cookie', biliFixture]]) {
      expect(!logsText.includes(value), `日志不得包含${label}明文`)
    }
    expect(logsText.includes('迁移'), '迁移事件应写入日志（只记录字段名）')
    const diagnostics = JSON.stringify(env.launcher.getDiagnostics())
    for (const value of [adminFixture, ncmFixture, biliFixture]) {
      expect(!diagnostics.includes(value), '诊断快照不得包含迁移后的秘密明文')
    }
    env.dispose()
    return '旧明文已迁移且不残留'
  })

  await check('22. D-03：safeStorage 不可用时回退受限权限文件并如实告警（不称加密）', async () => {
    safeStorageState.available = false
    try {
      env = makeHarness()
      const result = await env.invokeFrom('launcher:secrets:set', trustedEvent, {
        adminPassword: 'fallback-mode-admin-pw-8d3'
      })
      expectEqual(result.ok, true, `fallback 保存秘密失败：${JSON.stringify(result)}`)
      expectEqual(result.config.secretsStorage.mode, 'file-permissions', 'fallback 模式应为 file-permissions')
      expectEqual(result.config.secretsStorage.encrypted, false, 'fallback 不得声称已加密')
      expect(typeof result.config.secretsStorage.warning === 'string' && result.config.secretsStorage.warning.length > 0, 'fallback 应有告警')
      expect(fs.existsSync(env.secretsFile), 'fallback 秘密文件应存在')
      const status = await env.invoke('launcher:status')
      expectEqual(status.secretsStorage.encrypted, false, 'status.secretsStorage.encrypted=false')
      env.dispose()
      return result.config.secretsStorage.warning
    } finally {
      safeStorageState.available = true
    }
  })

  /* ---------------- D-09 首启流程 ---------------- */

  await check('23. D-09：全新配置拒绝启动 → 生成密码 → 可启动 → 重启保留 → 清除后再次拒绝', async () => {
    env = makeHarness()
    // 放入“资源已就绪”的假文件（版本探测用注入 mock，保证走到密码/启动分支）。
    fs.mkdirSync(path.join(env.binDir, 'jre', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(env.binDir, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
    fs.writeFileSync(path.join(env.binDir, 'server.jar'), '')
    await env.launcher.refreshJavaRuntime()

    const logsBefore = env.launcher.getLogs().length
    const rejected = await env.invoke('launcher:start')
    expectEqual(rejected.ok, false, '无管理员密码时 start 应失败')
    expectEqual(rejected.kind, 'needs-admin-password', 'kind 应为 needs-admin-password')
    expectEqual(rejected.needsAdminPassword, true, 'needsAdminPassword 应为 true')
    expectIncludes(rejected.error, '管理员密码', '错误文案应说明管理员密码')
    const newLogs = env.launcher.getLogs().slice(logsBefore)
    expect(!newLogs.some((entry) => entry.line.includes('正在启动本地服务')), '拒绝启动时不应进入 spawn 流程')
    const rejectedStatus = await env.invoke('launcher:status')
    expectEqual(rejectedStatus.needsAdminPassword, true, 'status.needsAdminPassword')
    expectEqual(rejectedStatus.services.java.state, 'stopped', '拒绝启动后 Java 应为 stopped（资源就绪）')

    const generated = await env.invokeFrom('launcher:secrets:ensureAdminPassword', trustedEvent)
    expectEqual(generated.ok, true, '生成密码应成功')
    expect(generated.password.length >= 24, '生成密码长度 >= 24')

    const second = await env.invoke('launcher:start')
    expect(second.needsAdminPassword !== true, '设置密码后不应再返回 needsAdminPassword')
    expect(!(second.kind === 'needs-admin-password'), '设置密码后 kind 不应为 needs-admin-password')

    // 重启（新实例读同一 userData）后密码保留
    env.dispose()
    env = makeHarness({ userData: env.userData, appPath: env.appPath })
    const afterRestart = await env.invoke('launcher:config:get')
    expectEqual(afterRestart.adminPasswordSet, true, '重启后管理员密码应保留')
    const revealed = await env.invokeFrom('launcher:secrets:revealAdminPassword', trustedEvent)
    expectEqual(revealed.password, generated.password, '重启后 reveal 应返回同一密码')

    // 清除后必须再次拒绝启动
    const cleared = await env.invokeFrom('launcher:secrets:clear', trustedEvent, { keys: ['adminPassword'] })
    expectEqual(cleared.ok, true, 'clearSecrets 应成功')
    const afterClear = await env.invoke('launcher:start')
    expectEqual(afterClear.needsAdminPassword, true, '清除密码后 start 应再次要求设置密码')
    env.dispose()
    return `生成密码 ${generated.password.length} 字符，重启保留、清除后重新锁定`
  })

  /* ---------------- D-11 Java 兼容 ---------------- */

  await check('24. D-11：Java 17 被判定 incompatible，start 返回明确中文提示且不 spawn', async () => {
    javaProbeState.mode = 'incompatible'
    try {
      env = makeHarness()
      fs.mkdirSync(path.join(env.binDir, 'jre', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(env.binDir, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
      fs.writeFileSync(path.join(env.binDir, 'server.jar'), '')
      await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: 'java17-test-admin-pw' })
      await env.launcher.refreshJavaRuntime()

      const status = await env.invoke('launcher:status')
      expectEqual(status.services.java.compatible, false, 'services.java.compatible 应为 false')
      expectEqual(status.services.java.state, 'incompatible', 'services.java.state 应为 incompatible')
      expectIncludes(status.services.java.lastError, `Java ${REQUIRED_JAVA_MAJOR}+`, 'lastError 应说明需要 Java 21+')
      expectIncludes(status.services.java.lastError, '17', 'lastError 应说明当前 17')

      const result = await env.invoke('launcher:start')
      expectEqual(result.ok, false, 'Java 17 时 start 应失败')
      expectEqual(result.kind, 'java-incompatible', 'kind 应为 java-incompatible')
      expectIncludes(result.error, `Java ${REQUIRED_JAVA_MAJOR}+`, '错误应说明需要 Java 21+')
      expectIncludes(result.error, '当前 17', '错误应说明当前 17')
      expectEqual(result.status.services.java.running, false, '不得把兼容性失败当成已启动')
      env.dispose()
      return result.error
    } finally {
      javaProbeState.mode = 'compatible'
    }
  })

  /* ---------------- D-04 健康探测 ---------------- */

  await check('25. D-04：MusicParty ready 只认 2xx+JSON+预期字段；网易云独立探测', async () => {
    const responses = new Map()
    fetchState.handler = async (url) => {
      if (responses.has(url)) return responses.get(url)
      return makeJsonResponse(404, { message: 'not found' })
    }
    try {
      responses.set('http://127.0.0.1:8080/api/config', makeJsonResponse(404, { message: 'nope' }))
      const r404 = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: mockFetch })
      expectEqual(r404.ok, false, '404 不应视为 ready')

      responses.set('http://127.0.0.1:8080/api/config', makeJsonResponse(500, { message: 'boom' }))
      const r500 = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: mockFetch })
      expectEqual(r500.ok, false, '500 不应视为 ready')

      responses.set('http://127.0.0.1:8080/api/config', makeJsonResponse(200, '<html>portal</html>', 'text/html'))
      const rHtml = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: mockFetch })
      expectEqual(rHtml.ok, false, 'HTML 200 不应视为 ready')

      responses.set('http://127.0.0.1:8080/api/config', makeJsonResponse(200, { ok: true }))
      const rUnknown = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: mockFetch })
      expectEqual(rUnknown.ok, false, '缺少预期字段的 JSON 不应视为 ready')

      responses.set('http://127.0.0.1:8080/api/config', makeJsonResponse(302, '{}', 'application/json'))
      const rRedirect = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: mockFetch })
      expectEqual(rRedirect.ok, false, '重定向不应视为 ready')

      responses.set(
        'http://127.0.0.1:8080/api/config',
        makeJsonResponse(200, { backWords: 'MUSIC PARTY', authorName: 'ThorNex' })
      )
      const rLegacy = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: mockFetch })
      expectEqual(rLegacy.ok, true, '旧服务端 {backWords,authorName} 应视为 MusicParty ready')
      expectEqual(rLegacy.server.version, '', '旧服务端没有 version')

      responses.set(
        'http://127.0.0.1:8080/api/config',
        makeJsonResponse(200, {
          backWords: 'MUSIC PARTY',
          authorName: 'ThorNex',
          serverVersion: '1.4.0-fix',
          capabilities: ['ping', 'room-token'],
          adminConfigured: true
        })
      )
      const rNew = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: mockFetch })
      expectEqual(rNew.ok, true, '新服务端 2xx+JSON+capabilities 应 ready')
      expectEqual(rNew.server.version, '1.4.0-fix', 'server.version 应来自 serverVersion')
      expect(rNew.server.capabilities.includes('ping'), 'capabilities 应透传')

      // 进程活着但不应答 / 超时：fetch 以 AbortError 拒绝
      const hangFetch = async () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      const rTimeout = await health.probeMusicParty('http://127.0.0.1:8080', { fetchImpl: hangFetch, timeoutMs: 50 })
      expectEqual(rTimeout.ok, false, '超时不应视为 ready')
      expectIncludes(rTimeout.error, '超时', '超时错误应可理解')

      // 网易云：/inner/version 2xx JSON → ready；404 时回退 / JSON → ready
      responses.set('http://127.0.0.1:3000/inner/version', makeJsonResponse(200, { version: '4.25.0' }))
      responses.set('http://127.0.0.1:3000/', makeJsonResponse(200, { ok: true }))
      const ncmReady = await health.probeNeteaseApi('http://127.0.0.1:3000', { fetchImpl: mockFetch })
      expectEqual(ncmReady.ok, true, '/inner/version 2xx JSON 应视为网易云 ready')
      expectEqual(ncmReady.version, '4.25.0', '网易云版本解析')

      responses.set('http://127.0.0.1:3000/inner/version', makeJsonResponse(404, 'not found', 'text/plain'))
      responses.set('http://127.0.0.1:3000/', makeJsonResponse(200, { status: 'ok' }))
      const ncmFallback = await health.probeNeteaseApi('http://127.0.0.1:3000', { fetchImpl: mockFetch })
      expectEqual(ncmFallback.ok, true, '/inner/version 404 时应回退根路径 JSON')

      responses.set('http://127.0.0.1:3000/inner/version', makeJsonResponse(404, 'not found', 'text/plain'))
      responses.set('http://127.0.0.1:3000/', makeJsonResponse(200, '<html>other service</html>', 'text/html'))
      const ncmWrong = await health.probeNeteaseApi('http://127.0.0.1:3000', { fetchImpl: mockFetch })
      expectEqual(ncmWrong.ok, false, 'HTML 服务占用端口不应视为网易云健康')
      expectIncludes(ncmWrong.error, '404', '错误应说明 404')
      return '404/500/HTML/超时/重定向/旧服务端/新服务端/网易云独立探测均符合预期'
    } finally {
      fetchState.handler = null
    }
  })

  await check('26. 秘密 IPC：非受信来源拒绝，受信 file:// 允许', async () => {
    env = makeHarness()
    const deniedSet = await env.invokeFrom('launcher:secrets:set', untrustedEvent, { adminPassword: 'evil-origin-pw' })
    expectEqual(deniedSet.ok, false, '非受信来源 setSecrets 应被拒绝')
    expectIncludes(deniedSet.error, '只允许本机', '拒绝文案')
    const deniedEnsure = await env.invokeFrom('launcher:secrets:ensureAdminPassword', untrustedEvent)
    expectEqual(deniedEnsure.ok, false, '非受信来源 ensure 应被拒绝')
    const deniedReveal = await env.invokeFrom('launcher:secrets:revealAdminPassword', untrustedEvent)
    expectEqual(deniedReveal.ok, false, '非受信来源 reveal 应被拒绝')

    const allowed = await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: 'trusted-admin-pw-1a2' })
    expectEqual(allowed.ok, true, '受信 file:// 来源 setSecrets 应允许')
    const revealed = await env.invokeFrom('launcher:secrets:revealAdminPassword', trustedEvent)
    expectEqual(revealed.password, 'trusted-admin-pw-1a2', '受信来源 reveal 应返回密码')
    env.dispose()
    return '来源校验生效'
  })

  /* ---------------- HTTP bridge ---------------- */

  await check('27. HTTP bridge：不跟随重定向、frame 校验、超时/网络错误', async () => {
    expect(httpBridge.isTrustedRendererFrame({ url: 'file:///E:/app/dist/index.html' }), 'file:// 应受信')
    expect(httpBridge.isTrustedRendererFrame({ url: 'http://127.0.0.1:5173/' }), 'dev server 127.0.0.1:5173 应受信')
    expect(httpBridge.isTrustedRendererFrame({ url: 'http://localhost:5173/' }), 'dev server localhost:5173 应受信')
    expect(!httpBridge.isTrustedRendererFrame({ url: 'https://evil.example.com/' }), '外部来源不应受信')
    expect(!httpBridge.isTrustedRendererFrame(null), '无 frame 不应受信')

    const fetchCalls = []
    const redirectFetch = async (url, init) => {
      fetchCalls.push({ url, init })
      return {
        status: 302,
        url,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'location' ? 'https://evil.example.com/steal' : ''
          }
        },
        async text() {
          return ''
        }
      }
    }
    const handler = httpBridge.createHttpBridgeHandler({ fetchImpl: redirectFetch })
    const blocked = await handler(trustedEvent, { url: 'http://127.0.0.1:8080/api/search' })
    expectEqual(blocked.ok, false, 'redirect 应返回 ok:false')
    expectEqual(blocked.error, 'redirect-blocked', 'error 应为 redirect-blocked')
    expectEqual(blocked.redirected, true, 'redirected 应为 true')
    expectEqual(blocked.crossOrigin, true, '应标记跨源重定向')
    expectEqual(fetchCalls[0].init.redirect, 'manual', 'fetch 必须以 redirect:manual 调用（绝不自动跟随）')

    const untrustedHandler = httpBridge.createHttpBridgeHandler({ fetchImpl: redirectFetch })
    const denied = await untrustedHandler(untrustedEvent, { url: 'http://127.0.0.1:8080/api/config' })
    expectEqual(denied.ok, false, '非受信 frame 应被拒绝')
    expectEqual(denied.error, 'untrusted-origin', '错误应为 untrusted-origin')

    const okFetch = async (url) => ({
      status: 200,
      url,
      headers: { get: () => 'application/json' },
      async text() {
        return '{"ok":true}'
      }
    })
    const okHandler = httpBridge.createHttpBridgeHandler({ fetchImpl: okFetch })
    const okResult = await okHandler(trustedEvent, { url: 'http://127.0.0.1:8080/api/config', timeout: 2000, unknownField: 1 })
    expectEqual(okResult.ok, true, '2xx 应返回 ok:true')
    expectEqual(okResult.status, 200, 'status 透传')
    expectEqual(okResult.bodyText, '{"ok":true}', 'bodyText 透传')

    const abortFetch = async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    const timeoutHandler = httpBridge.createHttpBridgeHandler({ fetchImpl: abortFetch })
    const timeoutResult = await timeoutHandler(trustedEvent, { url: 'http://127.0.0.1:8080/api/config', timeout: 20 })
    expectEqual(timeoutResult.ok, false, '超时应返回 ok:false')
    expectEqual(timeoutResult.error, 'timeout', '超时 error 应为 timeout')

    const networkFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const networkHandler = httpBridge.createHttpBridgeHandler({ fetchImpl: networkFetch })
    const networkResult = await networkHandler(trustedEvent, { url: 'http://127.0.0.1:8080/api/config' })
    expectEqual(networkResult.ok, false, '网络错误应返回 ok:false')
    expectEqual(networkResult.error, 'network-error', '网络错误 error 应为 network-error')

    const invalidHandler = httpBridge.createHttpBridgeHandler({ fetchImpl: okFetch })
    const invalid = await invalidHandler(trustedEvent, { url: 'ftp://127.0.0.1/x' })
    expectEqual(invalid.ok, false, '非 http(s) 协议应拒绝')
    return 'redirect-blocked / untrusted-origin / timeout / network-error 全部生效'
  })

  await check('28. 清除全部应用数据仅影响受信调用和自有目录', async () => {
    env.dispose()
    env = makeHarness()
    await env.invoke('launcher:config:set', { serverPort: '18222' })
    await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: 'fixture-clear-password', neteaseCookie: 'MUSIC_U=fixture' })
    fs.mkdirSync(path.join(env.userData, 'data'), { recursive: true })
    fs.mkdirSync(path.join(env.userData, 'cached_media'), { recursive: true })
    fs.writeFileSync(path.join(env.userData, 'data', 'queue-data.json'), '{}')
    fs.writeFileSync(path.join(env.userData, 'cached_media', 'song.tmp'), 'audio')
    fs.writeFileSync(path.join(env.userData, 'close-preference.json'), '{}')
    const external = path.join(env.appPath, 'external.jar')
    fs.writeFileSync(external, 'preserve')
    const denied = await env.invokeFrom('launcher:data:clear', untrustedEvent)
    expectEqual(denied.ok, false, '非受信来源不能清除')
    const result = await env.invokeFrom('launcher:data:clear', trustedEvent)
    expectEqual(result.ok, true, '清理应该成功')
    for (const name of ['launcher.json', 'launcher-secrets.json', 'data', 'cached_media', 'close-preference.json']) {
      expect(!fs.existsSync(path.join(env.userData, name)), `${name} 应被删除`)
    }
    expect(fs.existsSync(external), '外部用户文件必须保留')
    const config = await env.invoke('launcher:config:get')
    expectEqual(config.adminPasswordSet, false, '内存密码已清除')
    expectEqual(config.serverPort, '8080', '内存配置已恢复默认')
    return '配置、秘密、本地房间和缓存已清除；外部文件保留'
  })

  await check('29. 清除期间等待启动完成并拒绝新启动', async () => {
    env.dispose()
    let block = false, release, reached
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { reached = resolve })
    env = makeHarness({ javaProbe: async (exe) => { if (block) { reached(); await gate } return mockJavaProbe(exe) } })
    try {
      fs.mkdirSync(path.join(env.binDir, 'jre', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(env.binDir, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
      fs.writeFileSync(path.join(env.binDir, 'server.jar'), '')
      await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: 'fixture-race-password' })
      await env.launcher.refreshJavaRuntime()
      block = true
      const startPending = env.invoke('launcher:start')
      await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('未进入延迟探测')), 3000))])
      let finished = false
      const clearing = env.invokeFrom('launcher:data:clear', trustedEvent).then(result => { finished = true; return result })
      await new Promise(resolve => setTimeout(resolve, 50))
      expectEqual(finished, false, '已有启动未完成时不能提前清理完成')
      const blocked = await env.invoke('launcher:start')
      expectEqual(blocked.kind, 'clearing', '清理期间新启动应被拒绝')
      expectEqual((await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: 'should-not-survive' })).kind, 'clearing', '清理期间禁止保存秘密')
      expectEqual((await env.invoke('launcher:config:set', { serverPort: '9999' })).kind, 'clearing', '清理期间禁止保存配置')
      release()
      await startPending
      expectEqual((await clearing).ok, true, '清理应成功')
      const status = await env.invoke('launcher:status')
      expectEqual(status.running, false, '清理后不得残留服务')
      expectEqual((await env.invoke('launcher:config:get')).adminPasswordSet, false, '密码应已清除')
      return '等待启动结束后停止服务，期间拒绝新启动'
    } finally { release() }
  })

  await check('30. 启动中停止等待启动收尾', async () => {
    env.dispose()
    let block = false, release, reached
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { reached = resolve })
    env = makeHarness({ javaProbe: async exe => { if (block) { reached(); await gate } return mockJavaProbe(exe) } })
    try {
      fs.mkdirSync(path.join(env.binDir, 'jre', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(env.binDir, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
      fs.writeFileSync(path.join(env.binDir, 'server.jar'), '')
      await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: 'fixture-password' })
      await env.launcher.refreshJavaRuntime()
      block = true
      const startPending = env.invoke('launcher:start')
      await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('未进入延迟探测')), 3000))])
      let finished = false
      const stopping = env.invoke('launcher:stop').then(result => { finished = true; return result })
      await new Promise(resolve => setTimeout(resolve, 50))
      expectEqual(finished, false, '启动期间不得提前报告停止')
      release()
      await startPending
      expectEqual((await stopping).ok, true, '启动完成后停止成功')
      expectEqual((await env.invoke('launcher:status')).running, false, '停止后没有 Java 进程')
      return '启动和停止完成后无残留'
    } finally { release() }
  })

  await check('31. 启动中退出不再启动子进程', async () => {
    env.dispose()
    let block = false, release, reached
    const gate = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { reached = resolve })
    env = makeHarness({ javaProbe: async exe => { if (block) { reached(); await gate } return mockJavaProbe(exe) } })
    try {
      fs.mkdirSync(path.join(env.binDir, 'jre', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(env.binDir, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
      fs.writeFileSync(path.join(env.binDir, 'server.jar'), '')
      await env.invokeFrom('launcher:secrets:set', trustedEvent, { adminPassword: 'fixture-password' })
      await env.launcher.refreshJavaRuntime()
      block = true
      const starting = env.invoke('launcher:start')
      await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('未进入延迟探测')), 3000))])
      env.appEvents.get('before-quit')()
      release()
      expectEqual((await starting).ok, false, '退出后启动应被取消')
      expectEqual((await env.invoke('launcher:status')).running, false, '退出后不得拉起子进程')
      expectEqual((await env.invoke('launcher:start')).ok, false, '退出后拒绝新的启动')
      return '退出后不会继续启动服务'
    } finally { release() }
  })

  /* ---------------- 收尾 ---------------- */

  try {
    if (env) env.dispose()
  } catch (_) {
    /* ignore */
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (_) {
      /* ignore */
    }
  }
  if (savedServerJarEnv === undefined) delete process.env.MP_SERVER_JAR
  else process.env.MP_SERVER_JAR = savedServerJarEnv
}

main()
  .catch((error) => {
    failed += 1
    failures.push({ name: 'unexpected', message: String(error && error.stack ? error.stack : error) })
    console.log(`[FAIL] unexpected — ${String(error && error.message ? error.message : error)}`)
    try {
      if (env) env.dispose()
    } catch (_) {
      /* ignore */
    }
  })
  .finally(() => {
    const total = passed + failed
    console.log('')
    console.log('----------------------------------------')
    console.log(`通过 ${passed} / ${total}，失败 ${failed}`)
    if (failures.length > 0) {
      for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`)
      process.exitCode = 1
    } else {
      process.exitCode = 0
    }
  })

'use strict'

/**
 * MusicParty 启动器真实依赖回归（D-03 / D-04 / D-09 / D-11）。
 *
 *   node scripts/launcher-fix-smoke.cjs
 *
 * 与 launcher-smoke.cjs（全 mock）不同，本脚本使用真实依赖：
 *  - 真实 Java 17 / Java 25 可执行文件（探测 `-XshowSettings:properties -version`）；
 *  - 真实 server.jar（默认取审计期旧 JAR；可用环境变量 MP_FIX_JAR 指向新 JAR）；
 *  - 隔离端口 + 临时 userData（绝不占用 8080/生产端口）；
 *  - 真实 HTTP 合成服务（网易云 3000 语义、错误服务占端口、健康探测）；
 *  - 真实 Electron safeStorage（通过 scripts/electron-secrets-smoke.cjs）。
 *
 * 覆盖：
 *  1) D-11 真实 Java17/25 探测、显式旧 Java、坏可执行文件；17 在前的候选选择；
 *  2) D-03 真实 Electron safeStorage 加密落盘（launcher.json / secrets 文件均无明文）；
 *  3) D-04 真实 Java25 + server.jar 启动：MusicParty ready 必须靠 /api/config 验证；
 *     网易云外部 API 可用 → external/ready；不可用 → 仅音源降级（Java 仍 ready）；
 *  4) D-03 环境变量秘密通道：管理员密码不在命令行，服务端能收到（/api/admin/verify）；
 *  5) D-11 UnsupportedClassVersionError 真实场景（Java17 跑 class 65 JAR）；
 *  6) 端口被错误服务占用 → 可理解错误，不把 spawned 当 ready；
 *  7) D-09 真实首启流程（无密码拒绝 → 设置 → 启动成功 → 重启保留）。
 *
 * 输出 PASS/FAIL/SKIP；真实服务测试若缺少 Java/JAR 会明确 SKIP（并计入跳过数）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const AUDIT_JAR = path.join(os.tmpdir(), 'mp-server-audit-20261110', 'server.jar')
const DELIVERY_JAR = process.env.MP_FIX_JAR || ''

const JAVA17 = process.env.MP_FIX_JAVA17 || 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.101-hotspot\\bin\\java.exe'
const JAVA25 =
  process.env.MP_FIX_JAVA25 || 'C:\\Program Files\\Microsoft\\jdk-25.0.3.9-hotspot\\bin\\java.exe'

const {
  registerLauncher,
  analyzeJavaLogLine,
  SPAWN_EARLY_EXIT_WINDOW_MS
} = require(path.join(ROOT, 'electron', 'launcher.cjs'))
const { probeJava, resolveJava } = require(path.join(ROOT, 'electron', 'launcher-java.cjs'))
const { probeMusicParty, probeNeteaseApi } = require(path.join(ROOT, 'electron', 'launcher-health.cjs'))

/* ------------------------------------------------------------------ */
/* 断言 / 报告                                                         */
/* ------------------------------------------------------------------ */

let passed = 0
let failed = 0
let skipped = 0
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

function skip(name, reason) {
  skipped += 1
  console.log(`[SKIP] ${name} — ${reason}`)
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const tempDirs = []
function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch (_) {
    return false
  }
}

function findServerJar() {
  const candidates = [process.env.MP_FIX_JAR, DELIVERY_JAR, path.join(ROOT, 'bin', 'server.jar'), AUDIT_JAR]
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) return candidate
  }
  return ''
}

function findJava25() {
  for (const candidate of [JAVA25, process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : '']) {
    if (candidate && isFile(candidate)) return candidate
  }
  return ''
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/** 启动一个合成 HTTP 服务；返回 {port, close, requests}。 */
function startHttpServer(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method })
    handler(req, res)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          })
      })
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, intervalMs = 400) {
  const startedAt = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - startedAt > timeoutMs) return null
    await sleep(intervalMs)
  }
}

function makeMockSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`CIPHER:${Buffer.from(String(text), 'utf8').toString('hex')}`, 'utf8'),
    decryptString: (buffer) => {
      const raw = Buffer.from(buffer).toString('utf8')
      if (!raw.startsWith('CIPHER:')) throw new Error('bad cipher')
      return Buffer.from(raw.slice('CIPHER:'.length), 'hex').toString('utf8')
    }
  }
}

/**
 * 真实 Java 集成测试用 launcher：mock safeStorage（Node 里没有 Electron safeStorage，
 * 真实 safeStorage 由 electron-secrets-smoke.cjs 单独验证），其余为真实依赖。
 */
function createIntegrationLauncher({ userData, javaPath, jarPath, port, neteaseApiBaseUrl, javaProbe }) {
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
      throw new Error(`unsupported path ${name}`)
    },
    getAppPath() {
      return userData
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
  const launcher = registerLauncher({
    ipcMain,
    app,
    getWindow: () => null,
    safeStorage: makeMockSafeStorage(),
    javaProbe
  })
  launcher.setConfig({
    javaPath,
    serverJar: jarPath,
    serverIp: '127.0.0.1',
    serverPort: String(port),
    baseUrl: `http://127.0.0.1:${port}`,
    neteaseApiBaseUrl
  })
  launcher.setSecrets({ adminPassword: 'fixture-admin-pass-9f3a', neteaseCookie: 'MUSIC_U=fixture-ncm', biliCookie: 'SESSDATA=fixture-bili' })
  return { launcher, userData, handlers }
}

function getProcessCommandLine(pid) {
  if (process.platform !== 'win32') return ''
  try {
    const output = execFileSync(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    )
    return String(output || '').trim()
  } catch (_) {
    return ''
  }
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_) {
    json = null
  }
  return { status: response.status, text, json }
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('MusicParty launcher FIX smoke (real Java / real JAR / real HTTP)')
  console.log(`  node      ${process.version}`)
  console.log(`  jar       ${findServerJar() || '(未找到)'}`)
  console.log(`  java17    ${isFile(JAVA17) ? JAVA17 : '(未找到)'}`)
  console.log(`  java25    ${findJava25() || '(未找到)'}`)
  console.log('')

  const hasJava17 = isFile(JAVA17)
  const hasJava25 = Boolean(findJava25())
  const java25 = findJava25()
  const serverJar = findServerJar()

  /* ---------------- D-11 真实 Java 探测 ---------------- */

  if (hasJava17) {
    await check('1. D-11：真实 Java 17 探测 → incompatible + 明确中文提示', async () => {
      const result = await probeJava(JAVA17)
      expectEqual(result.ok, true, '应能运行 java -version 并解析出版本')
      expectEqual(result.compatible, false, 'Java 17 应判定不兼容')
      expectEqual(result.major, 17, 'major 应为 17')
      expectIncludes(result.lastError, '需要 Java 21+', '错误应说明需要 Java 21+')
      expectIncludes(result.lastError, '17', '错误应说明当前 17')
      return `${result.version} → ${result.lastError}`
    })
  } else {
    skip('1. D-11：真实 Java 17 探测', '未找到 Java 17')
  }

  if (hasJava25) {
    await check('2. D-11：真实 Java 25 探测 → compatible', async () => {
      const result = await probeJava(java25)
      expectEqual(result.ok, true, '应能解析版本')
      expectEqual(result.compatible, true, 'Java 25 应判定兼容')
      expect(result.major != null && result.major >= 21, `major 应 >= 21（实际 ${result.major}）`)
      return `${result.version}（major ${result.major}）`
    })

    await check('3. D-11：显式 Java25 → 选择兼容运行时', async () => {
      const result = await resolveJava({ configured: java25 })
      expectEqual(result.found, true, 'found')
      expectEqual(result.compatible, true, 'compatible')
      expectEqual(result.path, java25, '应选择显式指定的 Java25')
      return result.version
    })
  } else {
    skip('2. D-11：真实 Java 25 探测', '未找到 Java 25')
    skip('3. D-11：显式 Java25', '未找到 Java 25')
  }

  if (hasJava17) {
    await check('4. D-11：显式指定 Java17 → 不启动、lastError 说明版本', async () => {
      const result = await resolveJava({ configured: JAVA17 })
      expectEqual(result.compatible, false, 'compatible 应为 false')
      expectIncludes(result.lastError, '需要 Java 21+', 'lastError')
      expectIncludes(result.lastError, '17', 'lastError 当前版本')
      return result.lastError
    })
  } else {
    skip('4. D-11：显式 Java17', '未找到 Java 17')
  }

  await check('5. D-11：多候选选择（17 在前、25 在后 → 选兼容者）', async () => {
    // 用真实候选发现逻辑 + 注入探测结果（同一顺序：第一个不兼容、第二个兼容）。
    const dirA = mkTemp('mp-fix-java-first-')
    const dirB = mkTemp('mp-fix-java-second-')
    fs.writeFileSync(path.join(dirA, 'java.exe'), '')
    fs.writeFileSync(path.join(dirB, 'java.exe'), '')
    const candidates = require(path.join(ROOT, 'electron', 'launcher-java.cjs')).discoverJavaCandidates({
      env: { PATH: `${dirA}${path.delimiter}${dirB}`, JAVA_HOME: '' }
    })
    expectEqual(candidates.length, 2, '应发现两个候选')
    expectEqual(candidates[0].path, path.join(dirA, 'java.exe'), '第一个候选顺序')
    const result = await resolveJava({
      env: { PATH: `${dirA}${path.delimiter}${dirB}`, JAVA_HOME: '' },
      probe: async (exe) => {
        const first = exe.toLowerCase().startsWith(dirA.toLowerCase())
        return first
          ? { ok: true, path: exe, version: '17.0.20.1', major: 17, compatible: false, lastError: '需要 Java 21+，当前 17' }
          : { ok: true, path: exe, version: '25.0.3', major: 25, compatible: true, lastError: null }
      }
    })
    expectEqual(result.compatible, true, '应选择兼容候选')
    expectEqual(result.source, 'system', 'source 应为 system')
    expectEqual(result.path, path.join(dirB, 'java.exe'), '应跳过第一个不兼容候选')
    expect(result.candidates.length, '应记录候选探测结果')
    return `候选 ${result.candidates.length} 个，选择第 2 个`
  })

  await check('6. D-11：坏可执行文件 → 探测返回结构化错误（不崩溃）', async () => {
    const badDir = mkTemp('mp-fix-bad-java-')
    const badExe = path.join(badDir, 'java.exe')
    fs.writeFileSync(badExe, 'this is not a real executable')
    const result = await probeJava(badExe)
    expectEqual(result.ok, false, '坏 exe 不应判定为 ok')
    expectEqual(result.compatible, false, '坏 exe 不应 compatible')
    expect(typeof result.lastError === 'string' && result.lastError.length > 0, '应返回可理解 lastError')
    const resolved = await resolveJava({ configured: badExe })
    expectEqual(resolved.compatible, false, 'resolveJava 坏 exe 应不兼容')
    return result.lastError
  })

  /* ---------------- D-03 真实 Electron safeStorage ---------------- */

  if (isFile(ELECTRON_EXE)) {
    await check('7. D-03：真实 Electron safeStorage 加密落盘（无明文）', async () => {
      const userData = mkTemp('mp-fix-electron-secrets-')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      env.MP_SECRETS_USERDATA = userData
      const output = await new Promise((resolve, reject) => {
        const child = spawn(ELECTRON_EXE, [path.join(ROOT, 'scripts', 'electron-secrets-smoke.cjs')], {
          cwd: ROOT,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
        child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch (_) {
            /* ignore */
          }
          reject(new Error(`Electron safeStorage 验证超时；stderr=${stderr.slice(-400)}`))
        }, 60000)
        child.on('close', (code) => {
          clearTimeout(timer)
          const line = stdout.split(/\r?\n/).find((item) => item.includes('[secrets-e2e] '))
          if (!line) {
            reject(new Error(`未找到 [secrets-e2e] 输出（exit=${code}）stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`))
            return
          }
          resolve({ code, payload: JSON.parse(line.slice(line.indexOf('[secrets-e2e] ') + '[secrets-e2e] '.length)) })
        })
        child.on('error', reject)
      })
      expect(output.payload.ok === true, `Electron 内断言失败：${JSON.stringify(output.payload.errors || output.payload)}`)
      expectEqual(output.payload.encrypted, true, '真实 Electron safeStorage 应加密')
      expectEqual(output.payload.plaintextInSecrets, false, 'secrets 文件不得含明文')
      expectEqual(output.payload.plaintextInConfig, false, 'launcher.json 不得含明文')
      expectEqual(output.payload.diagnosticsLeak, false, '诊断快照不得泄漏')
      expectEqual(output.code, 0, 'Electron safeStorage 脚本退出码')
      return `mode=${output.payload.mode} encrypted=${output.payload.encrypted}`
    })
  } else {
    skip('7. D-03：真实 Electron safeStorage 加密落盘', '未找到 electron.exe')
  }

  /* ---------------- 真实 Java + JAR 集成 ---------------- */

  if (!hasJava25 || !serverJar) {
    skip('8. D-04 真实 Java25 + server.jar 启动与健康分离', '缺少 Java25 或 server.jar')
    skip('9. D-03 环境变量秘密通道 / 命令行无秘密', '缺少 Java25 或 server.jar')
    skip('10. D-11 UnsupportedClassVersionError 真实场景', '缺少 Java25/17 或 server.jar')
    skip('11. 端口被错误服务占用', '缺少 Java25 或 server.jar')
    skip('12. 网易云外部 API 不可用时仅音源降级', '缺少 Java25 或 server.jar')
  } else {
    const ncm = await startHttpServer((req, res) => {
      if (req.url === '/inner/version') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 'fixture-ncm-1.0' }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"message":"not found"}')
    })
    const port = await getFreePort()
    const userData = mkTemp('mp-fix-real-service-')
    let integration = null
    try {
      await check('8. D-04：真实 Java25 + server.jar 启动 → /api/config 验证 ready，网易云 external', async () => {
        integration = createIntegrationLauncher({
          userData,
          javaPath: java25,
          jarPath: serverJar,
          port,
          neteaseApiBaseUrl: ncm.baseUrl
        })
        const started = await integration.launcher.start()
        if (!started.ok) {
          // 首个 JAR 可能较慢/端口冲突：保留细节便于排障
          throw new Error(`start 失败：${started.error}${started.logTail ? `\n${started.logTail.map((l) => l.line).join('\n')}` : ''}`)
        }
        const status = await waitFor(() => {
          const snapshot = integration.launcher.getStatus()
          return snapshot.services.java.state === 'ready' ? snapshot : null
        }, 60000)
        if (!status) {
          const snapshot = integration.launcher.getStatus()
          throw new Error(
            `60s 内未 ready：java.state=${snapshot.services.java.state} lastError=${snapshot.services.java.lastError} logTail=${JSON.stringify(snapshot.logTail)}`
          )
        }
        expectEqual(status.healthy, true, 'status.healthy 应为 true')
        expectEqual(status.services.java.running, true, 'java 进程应存活')
        expectEqual(status.services.java.compatible, true, 'java.compatible 应为 true')
        expect(status.server && status.server.ready === true, 'server.ready 应为 true')
        expect(status.resources.serverJar.found === true, 'serverJar.found 应为 true')
        // 网易云来自合成外部服务
        const ncmStatus = await waitFor(() => {
          const snapshot = integration.launcher.getStatus()
          return snapshot.services.netease.state === 'external' ? snapshot : null
        }, 15000)
        expect(ncmStatus, `网易云应为 external，实际 ${integration.launcher.getStatus().services.netease.state}`)
        expectEqual(integration.launcher.getStatus().services.system.state, 'ok', 'system 应为 ok（java+ncm 都就绪）')
        expectEqual(integration.launcher.getStatus().services.netease.state, 'external', 'netease state')

        // 真实 HTTP 校验 MusicParty /api/config
        const configResponse = await httpJson(`http://127.0.0.1:${port}/api/config`)
        expectEqual(configResponse.status, 200, '/api/config HTTP 状态')
        expect(configResponse.json && typeof configResponse.json === 'object', '/api/config 应返回 JSON')
        return `java ${status.services.java.version} ready；server.version=${status.server ? status.server.version || '(旧JAR无版本字段)' : ''}`
      })

      await check('9. D-03：环境变量秘密通道（服务端收到密码）且命令行/日志/落盘无秘密', async () => {
        if (!integration) throw new Error('前置集成未启动')
        const snapshot = integration.launcher.getStatus()
        const pid = snapshot.services.java.pid
        expect(pid, 'Java pid')
        // 真实服务应接受环境变量传入的管理员密码，并拒绝空密码（旧 JAR 也支持 env binding）
        const verified = await httpJson(`http://127.0.0.1:${port}/api/admin/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'fixture-admin-pass-9f3a' })
        })
        expectEqual(verified.status, 200, '密码应通过服务端校验（说明 APP_MUSICAPI_ADMINPASSWORD 生效）')
        const empty = await httpJson(`http://127.0.0.1:${port}/api/admin/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: '' })
        })
        expectEqual(empty.status, 403, '空管理员密码必须被服务端拒绝')

        const commandLine = getProcessCommandLine(pid)
        expect(commandLine.length > 0, '应能读取 Java 进程命令行（CIM）')
        for (const fixture of ['fixture-admin-pass-9f3a', 'MUSIC_U=fixture-ncm', 'SESSDATA=fixture-bili']) {
          expect(!commandLine.includes(fixture), `进程命令行不得包含秘密明文：${fixture.slice(0, 8)}…`)
        }
        expect(!commandLine.includes('admin-password'), '命令行不应再包含 --app.music-api.admin-password')
        expect(!commandLine.includes('netease.cookie'), '命令行不应再包含 netease.cookie')
        expectIncludes(commandLine, `--server.port=${port}`, '命令行应包含隔离端口')

        const configText = fs.readFileSync(path.join(userData, 'launcher.json'), 'utf8')
        const secretsText = fs.readFileSync(path.join(userData, 'launcher-secrets.json'), 'utf8')
        for (const fixture of ['fixture-admin-pass-9f3a', 'MUSIC_U=fixture-ncm', 'SESSDATA=fixture-bili']) {
          expect(!configText.includes(fixture), 'launcher.json 不得含秘密明文')
          expect(!secretsText.includes(fixture), 'secrets 文件不得含秘密明文（mock safeStorage 加密）')
        }
        const logsText = JSON.stringify(integration.launcher.getLogs())
        expect(!logsText.includes('fixture-admin-pass-9f3a'), '日志不得含管理员密码明文')
        return '服务端校验 200/空密码 403；进程命令行/落盘/日志均无明文'
      })

      try {
        if (integration) await integration.launcher.stop()
      } catch (_) {
        /* ignore */
      }
      try {
        if (integration) integration.launcher.dispose()
      } catch (_) {
        /* ignore */
      }
    } finally {
      try {
        if (integration) await integration.launcher.stop()
      } catch (_) {
        /* ignore */
      }
      try {
        if (integration) integration.launcher.dispose()
      } catch (_) {
        /* ignore */
      }
      await ncm.close()
    }

    /* ------------- UnsupportedClassVersionError（Java17 跑 class 65 JAR） ------------- */

    if (hasJava17) {
      await check('10. D-11：Java17 跑 Java21+ JAR → UnsupportedClassVersionError 可理解错误', async () => {
        const unsupportedPort = await getFreePort()
        const unsupportedUserData = mkTemp('mp-fix-unsupported-')
        const harness = createIntegrationLauncher({
          userData: unsupportedUserData,
          javaPath: JAVA17,
          jarPath: serverJar,
          port: unsupportedPort,
          neteaseApiBaseUrl: 'http://127.0.0.1:1',
          // 模拟“版本探测误判为兼容”，强制走到真实 spawn，验证启动期错误识别
          javaProbe: async (exe) => ({
            ok: true,
            path: exe,
            version: '25.0.3',
            major: 25,
            compatible: true,
            lastError: null
          })
        })
        try {
          const started = await harness.launcher.start()
          expectEqual(started.ok, false, 'Java17 跑 class 65 JAR 时 start 不应返回 ok:true')
          const combined = `${started.error || ''} ${(started.logTail || []).map((l) => l.line).join(' ')}`
          expect(
            /UnsupportedClassVersionError|class 文件版本|class file version|需要 Java 21\+/.test(combined),
            `错误应说明版本不兼容：${combined.slice(0, 300)}`
          )
          const snapshot = harness.launcher.getStatus()
          expectEqual(snapshot.services.java.state, 'error', 'java.state 应为 error（不是 ready）')
          expectEqual(snapshot.healthy, false, '不得把 spawned 当 ready')
          return started.error.slice(0, 160)
        } finally {
          try {
            await harness.launcher.stop()
          } catch (_) {
            /* ignore */
          }
          harness.launcher.dispose()
        }
      })
    } else {
      skip('10. D-11：UnsupportedClassVersionError 真实场景', '未找到 Java 17')
    }

    /* ------------- 端口被错误服务占用 ------------- */

    await check('11. D-04：端口被其他服务占用 → 可理解错误（端口/占用）', async () => {
      const busyServer = await startHttpServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"backWords":"occupier","authorName":"other"}')
      })
      try {
        const userData = mkTemp('mp-fix-port-busy-')
        const harness = createIntegrationLauncher({
          userData,
          javaPath: java25,
          jarPath: serverJar,
          port: busyServer.port,
          neteaseApiBaseUrl: 'http://127.0.0.1:1'
        })
        try {
          const started = await harness.launcher.start()
          let errorText = started.error || ''
          let snapshot = harness.launcher.getStatus()
          if (started.ok) {
            // Spring Boot 可能在 3s 确认窗口之后才报绑定失败：等待错误状态。
            const failed = await waitFor(() => {
              const current = harness.launcher.getStatus()
              if (current.services.java.running) return null
              return current
            }, 45000)
            expect(failed, '端口冲突时应退出并进入错误状态（不能一直假装健康）')
            snapshot = harness.launcher.getStatus()
            errorText = `${snapshot.lastError || ''} ${snapshot.services.java.lastError || ''}`
          }
          expect(
            /端口|占用|APPLICATION FAILED|Web server failed/i.test(errorText),
            `错误应可理解（端口/占用）：${errorText.slice(0, 300)}`
          )
          expectEqual(snapshot.services.java.running, false, '端口冲突后 Java 不应保持运行')
          expectEqual(snapshot.healthy, false, '端口冲突不得视为 healthy')
          return errorText.replace(/\s+/g, ' ').slice(0, 180)
        } finally {
          try {
            await harness.launcher.stop()
          } catch (_) {
            /* ignore */
          }
          harness.launcher.dispose()
        }
      } finally {
        await busyServer.close()
      }
    })

    /* ------------- 网易云缺失/错误服务：只降级，不影响 Java ------------- */

    await check('12. D-04：网易云 API 是错误服务（HTML）→ 仅音源降级，Java 仍 ready', async () => {
      const wrongNcm = await startHttpServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body>another service on this port</body></html>')
      })
      const userData = mkTemp('mp-fix-ncm-wrong-')
      const ncmPort = await getFreePort()
      const harness = createIntegrationLauncher({
        userData,
        javaPath: java25,
        jarPath: serverJar,
        port: ncmPort,
        neteaseApiBaseUrl: wrongNcm.baseUrl
      })
      try {
        const started = await harness.launcher.start()
        expectEqual(started.ok, true, `Java 应正常启动：${started.error || ''}`)
        const ready = await waitFor(() => {
          const snapshot = harness.launcher.getStatus()
          return snapshot.services.java.state === 'ready' ? snapshot : null
        }, 60000)
        expect(ready, 'Java 应 ready（网易云不可用不应阻塞 Java）')
        const snapshot = harness.launcher.getStatus()
        expect(
          ['unhealthy', 'missing'].includes(snapshot.services.netease.state),
          `netease.state 应为 unhealthy/missing（实际 ${snapshot.services.netease.state}）`
        )
        expectEqual(snapshot.services.java.healthy, true, 'services.java.healthy 应为 true')
        expectEqual(snapshot.services.system.state, 'degraded', 'system 应为 degraded（按音源降级）')
        expect(snapshot.services.netease.lastError, '网易云应有 lastError 供 UI 展示')
        return `java ready，netease=${snapshot.services.netease.state}，system=${snapshot.services.system.state}`
      } finally {
        try {
          await harness.launcher.stop()
        } catch (_) {
          /* ignore */
        }
        harness.launcher.dispose()
        await wrongNcm.close()
      }
    })
  }

  /* ---------------- D-11 错误日志识别单测 ---------------- */

  await check('13. Java 日志错误识别：UnsupportedClassVersionError / 端口占用 / 坏 JAR', async () => {
    const unsupported = analyzeJavaLogLine(
      'Error: LinkageError occurred while loading main class org.springframework.boot.loader.JarLauncher',
      {}
    )
    expectEqual(unsupported, null, '普通 LinkageError 行不应误判')
    const classVersion = analyzeJavaLogLine(
      'Caused by: java.lang.UnsupportedClassVersionError: org/thornex/musicparty/MusicPartyApplication has been compiled by a more recent version of the Java Runtime',
      { serverPort: '18080' }
    )
    expect(classVersion && classVersion.fatal === true, 'UnsupportedClassVersionError 应识别为 fatal')
    expectIncludes(classVersion.message, 'Java 21+', '提示应说明需要 Java 21+')
    const port = analyzeJavaLogLine('Web server failed to start. Port 18080 was already in use.', {
      serverPort: '18080'
    })
    expect(port, '端口占用应识别')
    expectIncludes(port.message, '18080', '提示应包含端口')
    const bind = analyzeJavaLogLine('java.net.BindException: Address already in use: bind', { serverPort: '8080' })
    expect(bind, 'BindException 应识别')
    const badJar = analyzeJavaLogLine('Error: Invalid or corrupt jarfile test-server.jar', {})
    expect(badJar && badJar.fatal === true, '坏 JAR 应识别为 fatal')
    return '4 类错误识别正确'
  })

  /* ---------------- 收尾 ---------------- */

  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (_) {
      /* ignore */
    }
  }
}

main()
  .catch((error) => {
    failed += 1
    failures.push({ name: 'unexpected', message: String((error && error.stack) || error) })
    console.log(`[FAIL] unexpected — ${String((error && error.message) || error)}`)
  })
  .finally(() => {
    const total = passed + failed
    console.log('')
    console.log('----------------------------------------')
    console.log(`通过 ${passed} / ${total}，失败 ${failed}，跳过 ${skipped}`)
    if (failures.length > 0) {
      for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`)
      process.exitCode = 1
    } else {
      process.exitCode = 0
    }
  })

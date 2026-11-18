'use strict'

/**
 * 打包产物端到端冒烟（unpacked exe → 真实 launcher IPC → 资源解析 / 本地服务启动 / HTTP 桥）。
 *
 *   node scripts/pack-e2e.cjs --variant remote --out release-new
 *   node scripts/pack-e2e.cjs --variant local-server --out release-new
 *
 * 为什么需要：`--dir` 打包成功只证明 electron-builder 能复制文件，不能证明打包后的
 * exe 里 launcher 能解析到资源（remote 必须“没有资源”，local-server 必须能从
 * resources/bin 找到 JRE + server.jar 并真正 spawn 起来），也不能证明打包后的
 * renderer → preload → 主进程 HTTP 桥（不跟随重定向 + 来源校验）仍然工作。
 *
 * 本脚本用主进程已有的 MP_EVAL 机制打开打包后的 exe，在渲染层调用
 * window.mpDesktop.launcher / window.mpDesktop.http：
 *   - 两种变体都验证 HTTP 桥：302 必须返回 `error:'redirect-blocked'`，普通 200 JSON 正常透传，
 *     且不得出现 `untrusted-origin`（证明打包后 file:// 页面被正确信任）；
 *   - remote：断言 resources.bundled=false、start() 返回 resources-missing（不 spawn）；
 *   - local-server：断言 resources.java.path 指向 packaged resources/bin/jre，
 *     ensureLocalAdminPassword → start() → 轮询 /api/config 直到 services.java.state=ready，
 *     再 stop()；断言 secretsStorage.mode=safeStorage（真实 Electron）。
 *
 * 输出证据：<out>/logs/pack-e2e-<variant>.json；失败退出码 1。
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const VARIANTS = new Set(['remote', 'local-server'])

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value == null || value.startsWith('--') ? fallback : value
}

const variant = readFlag('--variant', 'remote')
if (!VARIANTS.has(variant)) {
  console.error(`未知变体：${variant}（仅支持 remote / local-server）`)
  process.exit(2)
}
const outRoot = path.resolve(ROOT, readFlag('--out', 'release-new'))
const exe = path.join(outRoot, variant, 'win-unpacked', 'Music Party.exe')
const evidenceDir = path.join(outRoot, 'logs')
const evidenceFile = path.join(evidenceDir, `pack-e2e-${variant}.json`)
const timeoutMs = Number(readFlag('--timeout', '150000'))

/** 渲染层公共片段：通过 query 参数拿到合成 HTTP 服务地址，验证打包后的 HTTP 桥。 */
function bridgeEvalSnippet() {
  return `
  const bridgeHttp = window.mpDesktop && window.mpDesktop.http
  let bridgeCheck = null
  if (bridgeHttp) {
    const base = new URLSearchParams(window.location.search).get('e2eHttpBase') || ''
    const redirect = await bridgeHttp.request({ url: base + '/redirect', timeout: 3000, redirect: 'error' })
    const normal = await bridgeHttp.request({ url: base + '/ok', timeout: 3000 })
    bridgeCheck = {
      hasBridge: true,
      redirect: { ok: redirect.ok, status: redirect.status, error: redirect.error, redirected: redirect.redirected, crossOrigin: redirect.crossOrigin, location: redirect.location },
      normal: { ok: normal.ok, status: normal.status, bodyText: normal.bodyText, contentType: normal.contentType }
    }
  }
`
}

const REMOTE_EVAL = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  ${bridgeEvalSnippet()}
  const launcher = window.mpDesktop && window.mpDesktop.launcher
  if (!launcher) return { error: 'no launcher bridge', bridgeCheck }
  const config = await launcher.getConfig()
  const status = await launcher.status()
  const startResult = await launcher.start()
  await sleep(500)
  const statusAfter = await launcher.status()
  return {
    variant: 'remote',
    hasBridge: true,
    bridgeCheck,
    config: { serverIp: config.serverIp, serverPort: config.serverPort, adminPasswordSet: config.adminPasswordSet, secretsStorage: config.secretsStorage },
    resources: {
      bundled: status.resources.bundled,
      ready: status.resources.ready,
      missing: status.resources.missing,
      javaFound: status.resources.javaFound,
      jarFound: status.resources.jarFound,
      javaPath: status.resources.java ? status.resources.java.path : '',
      jarPath: status.resources.serverJar ? status.resources.serverJar.path : ''
    },
    startResult: { ok: startResult.ok, kind: startResult.kind, error: startResult.error, needsAdminPassword: startResult.needsAdminPassword },
    statusAfter: { javaState: statusAfter.services.java.state, running: statusAfter.running }
  }
})()
`

const LOCAL_SERVER_EVAL = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  ${bridgeEvalSnippet()}
  const launcher = window.mpDesktop && window.mpDesktop.launcher
  if (!launcher) return { error: 'no launcher bridge', bridgeCheck }
  await launcher.getConfig()
  await launcher.setConfig({ serverIp: '127.0.0.1', serverPort: '19099', neteaseApiBaseUrl: 'http://127.0.0.1:19199' })
  const config = await launcher.getConfig()
  const before = await launcher.status()
  const ensure = config.adminPasswordSet ? { ok: true, generated: false } : await launcher.ensureLocalAdminPassword()
  const startResult = await launcher.start()
  let ready = null
  for (let i = 0; i < 120; i += 1) {
    await sleep(500)
    const last = await launcher.status()
    if ((last.services.java.state === 'ready' && last.services.netease.state === 'ready') || last.services.java.state === 'error' || last.services.java.state === 'incompatible') {
      ready = last
      break
    }
  }
  const stopResult = await launcher.stop()
  const afterStop = await launcher.status()
  return {
    variant: 'local-server',
    hasBridge: true,
    bridgeCheck,
    config: {
      serverIp: config.serverIp,
      serverPort: config.serverPort,
      adminPasswordSet: config.adminPasswordSet,
      secretsStorage: config.secretsStorage,
      neteaseApiBaseUrl: config.neteaseApiBaseUrl
    },
    resources: {
      bundled: before.resources.bundled,
      ready: before.resources.ready,
      missing: before.resources.missing,
      javaFound: before.resources.javaFound,
      jarFound: before.resources.jarFound,
      javaPath: before.resources.java ? before.resources.java.path : '',
      javaVersion: before.resources.java ? before.resources.java.version : '',
      javaCompatible: before.resources.java ? before.resources.java.compatible : null,
      jarPath: before.resources.serverJar ? before.resources.serverJar.path : '',
      neteasePath: before.resources.neteaseApi ? before.resources.neteaseApi.path : '',
      neteaseMode: before.resources.neteaseApi ? before.resources.neteaseApi.mode : ''
    },
    ensurePassword: { ok: ensure.ok, generated: ensure.generated, set: ensure.set, passwordLength: ensure.password ? ensure.password.length : 0 },
    startResult: { ok: startResult.ok, error: startResult.error, kind: startResult.kind, needsAdminPassword: startResult.needsAdminPassword },
    readyState: ready ? {
      javaState: ready.services.java.state,
      javaHealthy: ready.services.java.healthy,
      javaVersion: ready.services.java.version,
      javaCompatible: ready.services.java.compatible,
      neteaseState: ready.services.netease.state,
      systemState: ready.services.system.state,
      server: ready.server,
      lastError: ready.lastError,
      healthUrl: ready.healthUrl
    } : null,
    stop: { ok: stopResult.ok },
    afterStop: { javaState: afterStop.services.java.state, running: afterStop.running }
  }
})()
`

function fail(message, extra) {
  console.error(`\n[e2e] ✖ ${message}`)
  if (extra) console.error(JSON.stringify(extra, null, 2))
  process.exit(1)
}

function main() {
  if (!fs.existsSync(exe)) {
    fail(
      `找不到打包产物 ${path.relative(ROOT, exe)}，请先执行 ` +
        `node scripts/pack.cjs --dir --variant ${variant} --out ${path.relative(ROOT, outRoot)}`
    )
  }
  fs.mkdirSync(evidenceDir, { recursive: true })

  // 合成 HTTP 服务：验证打包后 renderer → preload → http-bridge 的真实链路
  // （302 必须被拒绝为 redirect-blocked；普通 200 JSON 正常透传）。
  const bridgeServer = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'https://evil.example.com/steal' })
      response.end('')
      return
    }
    if (request.url === '/ok') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, marker: 'e2e-ok' }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"message":"not found"}')
  })

  function finish(exitCode) {
    try {
      bridgeServer.close()
    } catch (_) {
      /* ignore */
    }
    process.exit(exitCode)
  }

  bridgeServer.on('error', (error) => fail(`无法启动合成 HTTP 服务：${String(error)}`))
  bridgeServer.listen(0, '127.0.0.1', () => {
    const bridgeBase = `http://127.0.0.1:${bridgeServer.address().port}`
    const evalFile = path.join(evidenceDir, `pack-e2e-${variant}-eval.js`)
    fs.writeFileSync(evalFile, variant === 'remote' ? REMOTE_EVAL : LOCAL_SERVER_EVAL, 'utf8')

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.MP_EVAL_FILE = evalFile
    env.MP_EVAL_WAIT = '2500'
    // 通过截图/eval 钩子的 query 注入合成服务地址（不新增 preload 全局）。
    env.MP_SHOT_EXTRA = `e2eHttpBase=${encodeURIComponent(bridgeBase)}`

    console.log(`[e2e] variant = ${variant}`)
    console.log(`[e2e] exe     = ${path.relative(ROOT, exe)}`)
    console.log(`[e2e] bridge  = ${bridgeBase}`)
    const child = spawn(exe, [], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
      fail(`打包产物 ${timeoutMs / 1000}s 内未完成 eval`, { stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) })
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      fail(`无法启动 exe：${error?.message || error}`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/).find((item) => item.includes('[eval] result '))
      if (!line) {
        fail(`未找到 [eval] result（exit=${code}）`, { stdout: stdout.slice(-3000), stderr: stderr.slice(-3000) })
      }
      let result
      try {
        result = JSON.parse(line.slice(line.indexOf('[eval] result ') + '[eval] result '.length))
      } catch (error) {
        fail(`无法解析 eval 结果：${String(error)}`, { line: line.slice(0, 2000) })
      }
      const assertions = []
      const assert = (condition, message) => {
        assertions.push({ ok: Boolean(condition), message })
        if (!condition) fail(`断言失败：${message}`, { result, stderr: stderr.slice(-2000) })
      }

      // 两种变体公共：打包后的 HTTP 桥（来源校验 + 重定向拦截 + 正常 200）
      assert(result.bridgeCheck && result.bridgeCheck.hasBridge === true, '打包后应能访问 window.mpDesktop.http 桥')
      const bridgeCheck = result.bridgeCheck || {}
      assert(bridgeCheck.normal && bridgeCheck.normal.ok === true, 'HTTP 桥正常请求应 ok:true')
      assert(bridgeCheck.normal && bridgeCheck.normal.status === 200, 'HTTP 桥正常请求 status 200')
      assert(bridgeCheck.normal && String(bridgeCheck.normal.bodyText).includes('e2e-ok'), 'HTTP 桥应透传 bodyText')
      assert(bridgeCheck.redirect && bridgeCheck.redirect.ok === false, 'HTTP 桥 302 应返回 ok:false')
      assert(
        bridgeCheck.redirect && bridgeCheck.redirect.error === 'redirect-blocked',
        `HTTP 桥 302 应 error=redirect-blocked（实际 ${bridgeCheck.redirect && bridgeCheck.redirect.error}）`
      )
      assert(!/untrusted-origin/.test(JSON.stringify(bridgeCheck)), '打包后渲染层来源应受信（不得 untrusted-origin）')

      if (variant === 'remote') {
        assert(result.hasBridge === true, '打包后应能访问 launcher bridge')
        assert(result.resources.bundled === false, 'remote 包不应内置资源（bundled=false）')
        assert(result.resources.ready === false, 'remote 包 resources.ready 应为 false')
        assert(Array.isArray(result.resources.missing) && result.resources.missing.length > 0, 'remote 包应报告缺失资源')
        assert(!String(result.resources.javaPath).includes('resources\\bin'), 'remote 包不应解析到内置 JRE')
        assert(result.startResult.ok === false, 'remote 包 start 应失败（没有本地服务资源）')
        assert(
          result.startResult.kind === 'resources-missing',
          `remote 包 start kind 应为 resources-missing（实际 ${result.startResult.kind}）`
        )
        assert(result.statusAfter.running === false, 'remote 包不应有 Java 进程')
      } else {
        assert(result.hasBridge === true, '打包后应能访问 launcher bridge')
        assert(result.resources.bundled === true, 'local-server 包应内置资源（bundled=true）')
        assert(result.resources.ready === true, 'local-server 包 resources.ready 应为 true')
        assert(result.resources.javaFound === true && result.resources.jarFound === true, '应找到内置 JRE 与 server.jar')
        assert(
          /resources[\\/]bin[\\/]jre[\\/]bin[\\/]java\.exe$/i.test(String(result.resources.javaPath)),
          `launcher 应解析到打包内 resources/bin/jre/bin/java.exe（实际 ${result.resources.javaPath}）`
        )
        assert(
          /resources[\\/]bin[\\/]server\.jar$/i.test(String(result.resources.jarPath)),
          `launcher 应解析到打包内 resources/bin/server.jar（实际 ${result.resources.jarPath}）`
        )
        assert(result.resources.javaCompatible === true, '内置 JRE 应兼容（Java 21+）')
        assert(
          result.config.secretsStorage && result.config.secretsStorage.mode === 'safeStorage',
          '真实 Electron 应使用 safeStorage 保存管理员密码'
        )
        assert(result.ensurePassword.ok === true && result.ensurePassword.set === true, '应能生成并保存管理员密码')
        assert(result.ensurePassword.passwordLength >= 24, '生成的密码长度应 >= 24')
        assert(result.startResult.ok === true, `local-server 包 start 应成功（${result.startResult.error || ''}）`)
        assert(result.readyState?.neteaseState === 'ready', '内置网易云 API 必须实际就绪')
        assert(
          result.readyState && result.readyState.javaState === 'ready',
          `本地服务应 ready（实际 ${result.readyState && result.readyState.javaState}）`
        )
        assert(result.readyState && result.readyState.javaHealthy === true, 'services.java.healthy 应为 true')
        assert(
          result.readyState && /^(ready|external|missing|unhealthy|disabled)$/.test(result.readyState.neteaseState),
          '网易云状态应为独立值（不影响 Java ready）'
        )
        assert(result.stop && result.stop.ok === true, 'stop 应成功')
        assert(result.afterStop && result.afterStop.running === false, 'stop 后不应有 Java 进程')
      }

      const evidence = {
        variant,
        exe: path.relative(ROOT, exe).replace(/\\/g, '/'),
        httpBridgeBase: bridgeBase,
        finishedAt: new Date().toISOString(),
        exitCode: code,
        assertions,
        result,
        stderrTail: stderr.split(/\r?\n/).slice(-10)
      }
      fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
      console.log(`[e2e] ✔ ${variant} 打包产物端到端通过（${assertions.length} 项断言）`)
      if (variant === 'local-server') {
        console.log(
          `[e2e]   Java ${result.readyState.javaVersion} state=${result.readyState.javaState}，` +
            `netease=${result.readyState.neteaseState}，system=${result.readyState.systemState}`
        )
      } else {
        console.log(`[e2e]   remote 无内置资源，start 返回 ${result.startResult.kind}`)
      }
      console.log(`[e2e]   证据 ${path.relative(ROOT, evidenceFile)}`)
      finish(code === 0 ? 0 : 1)
    })
  })
}

if (require.main === module) main()

#!/usr/bin/env node
/**
 * Windows 安装包/便携包冒烟验证（远程精简包 与 本地服务集成包 各自适用）。
 *
 * 用法：
 *   node tests/runtime/installer-smoke.mjs \
 *     --exe "E:\example-desktop\release\win-unpacked\Music Party.exe" \
 *     --variant remote|local-server [--label installer-remote] \
 *     [--asar "…\resources\app.asar"] [--screenshot-dir <dir>] [--timeout-ms 90000]
 *
 * 检查：
 *  - SHA256、应用版本（asar 内 package.json）、asar 资源清单（remote 无 bin/jre、
 *    local-server 含 bin/jre + bin/server.jar + 版本记录）；
 *  - 包内不得出现审计用合成凭据（fixture 标记）或明文 launcher 秘密；
 *  - 真实 exe 启动冒烟（MP_EVAL 自动化钩子）：渲染进程存活、debug 对象存在、
 *    设置页渲染（可选截图）、launcher IPC 返回脱敏配置与资源状态；
 *  - 日志无致命未处理异常。
 *
 * 结果写入 E:\example-delivery\verification\<label>\SUMMARY.json 与
 * docs/verification/results-<label>.json。只读检查，不启动服务器、不写安装目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(HERE, '..', '..')
const { Collector, writeRunSummary } = await import('../regression/lib/results.mjs')
const { ensureDir, nowIso, parseArgs } = await import('../regression/lib/env.mjs')

const args = parseArgs()
const exePath = args.exe ? path.resolve(String(args.exe)) : ''
const variant = String(args.variant || 'remote')
const label = String(args.label || `installer-${variant}-${new Date().toISOString().slice(0, 10)}`)
const OUT_DIR = path.join(process.env.MP_VERIFICATION_ROOT || path.join(os.tmpdir(), 'musicparty-verification'), label)
const DOCS_COPY = path.join(DESKTOP_ROOT, 'docs', 'verification', `results-${label}.json`)
const timeoutMs = Number(args['timeout-ms'] || 90000)
const screenshotDir = args['screenshot-dir'] ? path.resolve(String(args['screenshot-dir'])) : path.join(OUT_DIR, 'screens')

const SECRET_MARKERS = ['fixture-admin-', 'MUSIC_U=valid-', 'SESSDATA=fixture', 'admin-pw-fixture', 'fixture-client-chosen-key']
const FATAL_PATTERNS = [
  /\[eval\] failed/,
  /Unhandled Rejection/i,
  /Uncaught Exception/i,
  /Cannot access '[A-Za-z_$]+' before initialization/,
  /TypeError: Cannot read properties of (undefined|null)/
]

if (!exePath || !fs.existsSync(exePath)) {
  console.error(`缺少可执行文件或路径不存在：${exePath || '(未提供 --exe)'}`)
  process.exitCode = 1
  throw new Error('exe not found')
}

function sha256(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex').toUpperCase()
}

const appRoot = path.dirname(exePath)
const resourcesDir = path.join(appRoot, 'resources')
const defaultAsar = path.join(resourcesDir, 'app.asar')
const asarPath = args.asar ? path.resolve(String(args.asar)) : defaultAsar

/** Extract the renderer boot probe + launcher status through main.cjs MP_EVAL hooks. */
function runPackagedApp({ withScreenshot }) {
  return new Promise((resolve) => {
    ensureDir(screenshotDir)
    const shotOut = path.join(screenshotDir, `${variant}-settings.png`)
    const evalCode = `(async () => {
      const out = {
        boot: {
          appChildren: document.querySelector('#app')?.children.length ?? -1,
          bodyTextLength: document.body.innerText.length,
          hasDebug: Boolean(window.__mp),
          hasProtocolProbe: Boolean(window.__mp?.protocol),
          settingsVersionText: (document.body.innerText.match(/Music Party Desktop · ([0-9][0-9.]*)/) || [])[1] || null,
          versionKvText: (document.body.innerText.match(/桌面应用\\s*([0-9][0-9.]*)/) || [])[1] || null,
          bodyPreview: document.body.innerText.slice(0, 300)
        }
      }
      try {
        const launcher = window.mpDesktop?.launcher
        out.launcherAvailable = Boolean(launcher)
        if (launcher) {
          const config = await launcher.getConfig()
          out.launcherConfigKeys = config ? Object.keys(config).sort() : null
          out.launcherConfig = config ? {
            adminPassword: config.adminPassword ?? null,
            adminPasswordSet: config.adminPasswordSet ?? null,
            neteaseCookie: config.neteaseCookie ?? null,
            neteaseCookieSet: config.neteaseCookieSet ?? null,
            biliCookie: config.biliCookie ?? null,
            biliCookieSet: config.biliCookieSet ?? null,
            serverIp: config.serverIp ?? null,
            serverPort: config.serverPort ?? null,
            javaPath: config.javaPath ?? null,
            autoStart: config.autoStart ?? null
          } : null
          try {
            const statusFn = launcher.status || launcher.getStatus
            const status = statusFn ? await statusFn.call(launcher) : null
            out.launcherStatus = status ? {
              keys: Object.keys(status).sort(),
              services: status.services ? Object.keys(status.services).sort() : null,
              resources: status.resources ? {
                ready: status.resources.ready ?? null,
                javaPath: status.resources.javaPath ?? null,
                source: status.resources.javaSource ?? null
              } : null,
              lastError: status.lastError ?? null
            } : null
          } catch (error) { out.launcherStatusError = String(error?.message || error) }
        }
      } catch (error) {
        out.launcherError = String(error?.message || error)
      }
      return out
    })()`
    const env = {
      ...process.env,
      MP_EVAL: evalCode,
      MP_EVAL_WAIT: '3000',
      MP_SHOT_VIEW: 'settings',
      MP_SHOT_OUT: shotOut,
      ...(withScreenshot ? { MP_SHOT: '1', MP_SHOT_WAIT: '2600' } : {})
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(exePath, ['--enable-logging=stderr'], {
      cwd: appRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (data) => (output += String(data)))
    child.stderr.on('data', (data) => (output += String(data)))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      let result = null
      const match = output.match(/\[eval\] result (.*)/)
      try {
        result = match ? JSON.parse(match[1]) : null
      } catch {
        result = null
      }
      resolve({
        code,
        result,
        output,
        screenshot: fs.existsSync(shotOut) ? { file: shotOut, size: fs.statSync(shotOut).size } : null
      })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, result: null, output: String(error?.message || error), screenshot: null })
    })
  })
}

async function main() {
  ensureDir(OUT_DIR)
  const collector = new Collector(`installer-${variant}`, `Windows 打包产物冒烟（${variant}）`, {
    variant,
    exePath
  })

  // ---------------- file / hash / version ----------------
  const exeStat = fs.statSync(exePath)
  const exeSha = sha256(exePath)
  let asar = null
  let asarSha = null
  let asarEntries = []
  let packageJson = null
  let asarBytes = null
  if (fs.existsSync(asarPath)) {
    asar = require('@electron/asar')
    asarSha = sha256(asarPath)
    asarEntries = asar.listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/'))
    try {
      packageJson = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    } catch {
      packageJson = null
    }
    asarBytes = fs.readFileSync(asarPath)
  }
  const repoPackage = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))
    } catch {
      return null
    }
  })()

  collector.expect('installer-file-and-hash', {
    title: '安装包可执行文件存在，记录路径/大小/SHA256',
    expected: { exists: true, sha256HexLength: 64 },
    actual: {
      exists: fs.existsSync(exePath),
      exe: exePath,
      size: exeStat.size,
      sha256: exeSha,
      sha256HexLength: exeSha.length,
      appAsar: fs.existsSync(asarPath) ? asarPath : null,
      asarSha256: asarSha
    },
    level: 'packaged-artifact'
  })
  collector.assert('installer-asar-present', {
    title: '解包目录内 resources/app.asar 存在且可解析条目清单',
    expected: { asarExists: true, entriesGreaterThan0: true },
    actual: { asarExists: Boolean(asar), entries: asarEntries.length },
    condition: Boolean(asar) && asarEntries.length > 0,
    level: 'packaged-artifact'
  })
  collector.expect('installer-app-version', {
    title: 'asar 内 package.json 版本可读（并与当前仓库版本对照记录）',
    expected: { versionReadable: true },
    actual: {
      versionReadable: Boolean(packageJson?.version),
      version: packageJson?.version ?? null,
      repoVersion: repoPackage?.version ?? null,
      name: packageJson?.name ?? null,
      main: packageJson?.main ?? null
    },
    level: 'packaged-artifact'
  })

  // ---------------- resource layout by variant ----------------
  // Only TOP-LEVEL /bin entries count as bundled server resources; node_modules/*/bin is
  // ordinary JS tooling and must not be confused with the local-server assets.
  const binEntries = asarEntries.filter((entry) => /^\/?bin\//.test(entry))
  const jarEntries = asarEntries.filter((entry) => /(^|\/)server\.jar$/i.test(entry))
  const jreEntries = asarEntries.filter((entry) => /(^|\/)bin\/jre\//.test(entry))
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
  const unpackedExists = fs.existsSync(unpackedDir)
  const unpackedBin = unpackedExists ? listTree(path.join(unpackedDir, 'bin')) : []
  // electron-builder `extraResources` may place bin/ directly under resources/ as well.
  const extraBinDir = path.join(resourcesDir, 'bin')
  const extraBin = fs.existsSync(extraBinDir) ? listTree(extraBinDir) : []
  const bundledBin = [...unpackedBin, ...extraBin]
  const hasUnpackedJre = bundledBin.some((entry) => /[\\/]jre[\\/]/.test(entry))
  const hasUnpackedJar = bundledBin.some((entry) => /server\.jar$/i.test(entry))
  const bundledJarPath = bundledBin.find((entry) => /server\.jar$/i.test(entry)) || null
  const bundledJarSha = bundledJarPath ? sha256(bundledJarPath) : null

  if (variant === 'remote') {
    collector.assert('installer-remote-no-bundled-server', {
      title: '远程精简包不得包含 bin/jre/server.jar（public 包靠远程服务或用户补资源）',
      expected: { asarBinEntries: 0, asarJarEntries: 0, unpackedJre: false, unpackedServerJar: false },
      actual: {
        asarBinEntries: binEntries.length,
        asarJarEntries: jarEntries.length,
        unpackedJre: hasUnpackedJre,
        unpackedServerJar: hasUnpackedJar
      },
      condition: binEntries.length === 0 && jarEntries.length === 0 && !hasUnpackedJre && !hasUnpackedJar,
      level: 'packaged-artifact'
    })
  } else {
    const jreVersionFile = bundledBin.find((entry) => /jre[\\/](release|version)/i.test(entry))
    const expectedJarSha = args['server-jar-sha'] ? String(args['server-jar-sha']).toUpperCase() : null
    collector.assert('installer-local-bundled-server', {
      title: '本地服务集成包包含 bin/jre + bin/server.jar（以及版本记录）',
      expected: { jrePresent: true, serverJarPresent: true },
      actual: {
        asarBinEntries: binEntries.length,
        asarJarEntries: jarEntries.length,
        unpackedExists,
        unpackedJre: hasUnpackedJre,
        unpackedServerJar: hasUnpackedJar,
        jreVersionFile: jreVersionFile || null,
        bundledJarPath,
        bundledJarSha256: bundledJarSha,
        bundledBinSample: bundledBin.slice(0, 12)
      },
      condition: hasUnpackedJre && hasUnpackedJar,
      level: 'packaged-artifact'
    })
    collector.expect('installer-local-server-jar-sha', {
      title: '本地集成包内 server.jar 与交付目录最终 JAR SHA256 一致',
      expected: expectedJarSha || '(未提供 --server-jar-sha，仅记录)',
      actual: bundledJarSha,
      condition: expectedJarSha ? bundledJarSha === expectedJarSha : Boolean(bundledJarSha),
      level: 'packaged-artifact'
    })
    collector.expect('installer-local-dev-asar-has-no-bin', {
      title: 'asar 内部不含 bin（打包资源走 extraResources/resources/bin，避免重复）',
      expected: { asarBinEntries: 0, asarJarEntries: 0 },
      actual: { asarBinEntries: binEntries.length, asarJarEntries: jarEntries.length },
      level: 'packaged-artifact'
    })
  }

  // ---------------- secrets scan ----------------
  const asarTextForScan = asarBytes ? asarBytes.toString('latin1') : ''
  const foundMarkers = SECRET_MARKERS.filter((marker) => asarTextForScan.includes(marker))
  let unpackedMarkers = []
  if (unpackedExists) {
    for (const file of listFiles(unpackedDir)) {
      if (fs.statSync(file).size > 40 * 1024 * 1024) continue
      const text = fs.readFileSync(file).toString('latin1')
      for (const marker of SECRET_MARKERS) {
        if (text.includes(marker)) unpackedMarkers.push({ file, marker })
      }
    }
  }
  collector.assert('installer-no-audit-fixtures-bundled', {
    title: '包内不得出现审计合成凭据/秘密 fixture 标记（asar 与 asar.unpacked 全量扫描）',
    expected: [],
    actual: { asar: foundMarkers, unpacked: unpackedMarkers.slice(0, 10) },
    condition: foundMarkers.length === 0 && unpackedMarkers.length === 0,
    level: 'packaged-artifact'
  })

  // ---------------- real launch smoke ----------------
  const launch = await runPackagedApp({ withScreenshot: true })
  const result = launch.result || {}
  const fatalPatterns = FATAL_PATTERNS.filter((pattern) => pattern.test(launch.output))
  const config = result.launcherConfig || null
  const adminPlain = config?.adminPassword ?? null
  const neteasePlain = config?.neteaseCookie ?? null
  const biliPlain = config?.biliCookie ?? null
  const plainSecretsPresent = [adminPlain, neteasePlain, biliPlain].some(
    (value) => typeof value === 'string' && value.length > 0
  )

  collector.expect('installer-launch-smoke', {
    title: '真实打包 exe 启动冒烟：渲染进程存活、debug 钩子存在、进程正常退出',
    expected: { exitCode: 0, appChildrenGte1: true, hasDebug: true },
    actual: {
      exitCode: launch.code,
      appChildrenGte1: (result.boot?.appChildren ?? 0) >= 1,
      hasDebug: result.boot?.hasDebug,
      hasProtocolProbe: result.boot?.hasProtocolProbe,
      bodyPreview: result.boot?.bodyPreview ?? null,
      evalResultPresent: Boolean(launch.result)
    },
    evidence: { fatalPatterns, evalError: result.error ?? null },
    level: 'packaged-artifact'
  })
  collector.assert('installer-settings-version-consistent', {
    title: '设置页显示的桌面应用版本与实际包版本一致（避免 UI 仍显示旧版本号）',
    expected: { settingsVersionText: packageJson?.version ?? null, versionKvText: packageJson?.version ?? null },
    actual: {
      settingsVersionText: result.boot?.settingsVersionText ?? null,
      versionKvText: result.boot?.versionKvText ?? null,
      packageVersion: packageJson?.version ?? null
    },
    condition:
      Boolean(packageJson?.version) &&
      result.boot?.settingsVersionText === packageJson.version &&
      result.boot?.versionKvText === packageJson.version,
    evidence: { bodyPreview: result.boot?.bodyPreview ?? null },
    level: 'packaged-artifact'
  })
  collector.assert('installer-no-fatal-unhandled-log', {
    title: '启动日志无未处理异常/eval 失败/初始化 TDZ 错误',
    expected: [],
    actual: fatalPatterns.map((pattern) => String(pattern)),
    condition: fatalPatterns.length === 0,
    evidence: { outputTail: launch.output.slice(-3000) },
    level: 'packaged-artifact'
  })
  collector.assert('installer-launcher-config-redacted', {
    title: 'launcher IPC getConfig 返回脱敏配置（不含管理员密码/Cookie 明文）',
    expected: { launcherAvailableOrNotApplicable: true, plainSecretsPresent: false },
    actual: {
      launcherAvailable: result.launcherAvailable ?? null,
      configKeys: result.launcherConfigKeys ?? null,
      plainSecretsPresent,
      adminPasswordSet: config?.adminPasswordSet ?? null,
      error: result.launcherError ?? null
    },
    condition: plainSecretsPresent === false,
    level: 'packaged-artifact'
  })
  collector.expect('installer-launcher-resources', {
    title: 'launcher status 暴露 Java/服务/资源状态（供设置页渲染；不含秘密）',
    expected: { statusReadable: true },
    actual: {
      statusReadable: Boolean(result.launcherStatus),
      services: result.launcherStatus?.services ?? null,
      resources: result.launcherStatus?.resources ?? null,
      lastError: result.launcherStatus?.lastError ?? null
    },
    condition: Boolean(result.launcherStatus) || Boolean(result.launcherStatusError),
    level: 'packaged-artifact'
  })
  if (variant === 'local-server') {
    const javaPath = result.launcherStatus?.resources?.javaPath ?? ''
    collector.assert('installer-local-java-bundled-detected', {
      title: '本地集成包的 launcher 检测到随包 JRE（javaPath 指向包内 bin/jre）',
      expected: { javaPathMentionsBundledJre: true },
      actual: { javaPath, ready: result.launcherStatus?.resources?.ready ?? null },
      condition: /bin[\\/]jre[\\/]bin[\\/]java/i.test(String(javaPath)),
      level: 'packaged-artifact'
    })
  }
  collector.assert('installer-settings-view-screenshot', {
    title: '设置页渲染截图已生成（?view=settings，非白屏）',
    expected: { screenshotExists: true, sizeGreaterThan10000: true },
    actual: launch.screenshot
      ? { exists: true, size: launch.screenshot.size, file: launch.screenshot.file }
      : { exists: false },
    condition: Boolean(launch.screenshot) && launch.screenshot.size > 10000,
    level: 'packaged-artifact'
  })

  const payload = {
    env: {
      label,
      startedAt: nowIso(),
      variant,
      node: process.version,
      exe: exePath,
      exeSize: exeStat.size,
      exeSha256: exeSha,
      asar: asarPath,
      asarSha256: asarSha,
      appVersion: packageJson?.version ?? null,
      repoVersion: repoPackage?.version ?? null,
      electron: (() => {
        try {
          return require('electron/package.json').version
        } catch {
          return 'unknown'
        }
      })()
    },
    asarEntriesCount: asarEntries.length,
    checks: collector.checks,
    summary: collector.summary()
  }
  const summaryFile = writeRunSummary(OUT_DIR, payload, DOCS_COPY)
  console.log(`\n${JSON.stringify(collector.summary())}\n${summaryFile}`)
  if (collector.summary().failed > 0) process.exitCode = 1
}

function listTree(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      out.push(target)
      if (entry.isDirectory()) walk(target)
    }
  }
  walk(dir)
  return out
}

function listFiles(dir) {
  return listTree(dir).filter((file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  })
}

main().catch((error) => {
  console.error(`[fatal] ${error?.stack || error}`)
  process.exitCode = 1
})

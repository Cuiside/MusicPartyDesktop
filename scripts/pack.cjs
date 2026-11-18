'use strict'

/**
 * Windows 打包入口（remote / local-server 双变体）。
 *
 * 用法：
 *   node scripts/pack.cjs --dir  --variant remote         # 免安装目录版（远程精简包）
 *   node scripts/pack.cjs --win  --variant remote         # portable + NSIS 安装包（远程精简包）
 *   node scripts/pack.cjs --dir  --variant local-server   # 免安装目录版（本地服务集成包）
 *   node scripts/pack.cjs --win  --variant local-server   # portable + NSIS 安装包（本地服务集成包）
 *
 * 可选参数：
 *   --out <dir>     不存在的新输出根目录（默认 release-build 下的唯一目录）
 *   --server-build <dir>  当前源码构建的 server.jar 和 server-build.json 所在目录
 *   --skip-build    跳过 vite build（复用已有 dist/，仅供本地快速验证）
 *
 * 变体语义（审计 D-05/D-07 修复）：
 *   remote       远程精简包：**不包含** bin/（无 server.jar / JRE / netease-api），
 *                安装包只负责连远程服务；发布门禁断言 asar 与 resources 内均无 bin/jre/jar。
 *   local-server 本地服务集成包：bin/ 通过 extraResources 复制到 resources/bin
 *                （app.getAppPath()/… 之外的 per-user 可执行资源，避免 asar 内无法 spawn），
 *                打包后断言 resources/bin/jre/bin/java.exe 与 resources/bin/server.jar 存在，
 *                并用内置 JRE 实际运行 `-version` + 校验 JAR 完整性。
 *
 * 产物与清单：
 *   <out>/<variant>/MusicParty-<version>-<variant>-setup-x64.exe
 *   <out>/<variant>/MusicParty-<version>-<variant>-portable-x64.exe
 *   <out>/<variant>/win-unpacked/…
 *   <out>/logs/pack-manifest.json   每次构建追加一条（artifact 路径/大小/SHA256/版本/内置资源）
 *
 * 中国网络环境默认使用 npmmirror（已设置的同类环境变量优先）：
 *   ELECTRON_BUILDER_BINARIES_MIRROR、ELECTRON_MIRROR
 *
 * 不签名（没有证书）：CSC_IDENTITY_AUTO_DISCOVERY=false，避免 electron-builder 等待签名工具。
 */

const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const { readJarInfo } = require('./lib/jar-inspect.cjs')
const { sourceDigest } = require('./lib/source-digest.cjs')

const ROOT = path.resolve(__dirname, '..')
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const BUILDER_BIN = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const CHECK_SCRIPT = path.join(__dirname, 'check-public-release.cjs')
const CANDIDATE_CHECK_SCRIPT = path.join(__dirname, 'check-candidate.cjs')
const ICON_FILE = path.join(ROOT, 'build', 'icon.ico')
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist')
const PACKAGE_JSON = path.join(ROOT, 'package.json')
const RESOURCE_META_FILE = path.join(ROOT, '.musicparty-resources.json')

const VARIANTS = new Set(['remote', 'local-server'])
const JRE_REQUIRED_MAJOR = 21
const JRE_DOWNLOAD_URL =
  'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse'

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2)

function readFlag(name, fallback) {
  const index = argv.indexOf(name)
  if (index < 0) return fallback
  const value = argv[index + 1]
  return value == null || value.startsWith('--') ? fallback : value
}

const mode = argv.includes('--dir') ? 'dir' : argv.includes('--win') ? 'win' : null
const variant = readFlag('--variant', 'local-server')
const serverBuildDir = path.resolve(ROOT, readFlag('--server-build', 'bin'))
const outRoot = path.resolve(ROOT, readFlag('--out', `release-build/${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`))
const skipBuild = argv.includes('--skip-build')

if (!mode) {
  console.error('用法: node scripts/pack.cjs --dir | --win  [--variant remote|local-server] [--out 新目录]')
  process.exit(2)
}
if (!VARIANTS.has(variant)) {
  console.error(`未知变体：${variant}（仅支持 ${[...VARIANTS].join(' / ')}）`)
  process.exit(2)
}

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
const outDir = path.join(outRoot, variant)
const logDir = path.join(outRoot, 'logs')
const unpackedDir = path.join(outDir, 'win-unpacked')
const manifestFile = path.join(logDir, 'pack-manifest.json')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logFile = path.join(logDir, `pack-${variant}-${mode}-${stamp}.log`)
const configFile = path.join(logDir, `pack-config-${variant}-${mode}-${stamp}.json`)

/* ---------------- 运行环境 ---------------- */

const env = { ...process.env }
// ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成 Node，构建/截图前必须移除。
delete env.ELECTRON_RUN_AS_NODE
if (!env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}
if (!env.ELECTRON_MIRROR) {
  env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}
if (!env.CSC_IDENTITY_AUTO_DISCOVERY) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

/* ---------------- 工具函数 ---------------- */

function mustExist(file, hint) {
  if (fs.existsSync(file)) return
  console.error(`[pack] 缺少 ${path.relative(ROOT, file)}：${hint}`)
  process.exit(1)
}

function dirSize(dirPath) {
  let total = 0
  let files = 0
  const stack = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        total += fs.statSync(full).size
        files += 1
      }
    }
  }
  return { bytes: total, files }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex').toUpperCase()
}

function run(label, command, args, { timeoutMs = 40 * 60 * 1000, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(logDir, { recursive: true })
    const log = fs.createWriteStream(logFile, { flags: 'a' })
    log.write(`\n=== ${label} ${new Date().toISOString()} ===\n$ ${command} ${args.join(' ')}\n`)
    const startedAt = Date.now()
    console.log(`\n[pack] ▶ ${label}\n       $ ${command} ${args.join(' ')}`)
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const forward = (stream, sink) => {
      stream.on('data', (chunk) => {
        sink.write(chunk)
        log.write(chunk)
      })
    }
    forward(child.stdout, process.stdout)
    forward(child.stderr, process.stderr)
    const timer = timeoutMs
      ? setTimeout(() => {
          console.error(`[pack] ✖ ${label} 超时（${Math.round(timeoutMs / 1000)}s），终止子进程`)
          child.kill()
        }, timeoutMs)
      : null
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      log.end()
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      log.end()
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      if (code === 0) {
        console.log(`[pack] ✔ ${label}（${seconds}s）`)
        resolve({ seconds })
      } else {
        reject(new Error(`${label} 失败，退出码 ${code}（${seconds}s），日志：${path.relative(ROOT, logFile)}`))
      }
    })
  })
}

function readDataDirSafe(target) {
  try {
    return fs.readdirSync(target)
  } catch (_) {
    return []
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return null
  }
}

/** 内置 JRE 版本信息（bin/jre/release）。 */
function readBundledJreInfo() {
  const releaseFile = path.join(ROOT, 'bin', 'jre', 'release')
  if (!fs.existsSync(releaseFile)) return null
  const text = fs.readFileSync(releaseFile, 'utf8')
  const read = (key) => {
    const match = new RegExp(`${key}="?([^"\\r\\n]+)"?`).exec(text)
    return match ? match[1].trim() : ''
  }
  return {
    version: read('JAVA_VERSION'),
    implementorVersion: read('IMPLEMENTOR_VERSION'),
    implementor: read('IMPLEMENTOR'),
    osArch: read('OS_ARCH'),
    imageType: read('IMAGE_TYPE')
  }
}

/**
 * JAR 结构/版本检查：委托 scripts/lib/jar-inspect.cjs（按 ZIP 中央目录解压
 * MANIFEST.MF 与 build-info.properties，得到 Implementation-Version / git revision）。
 */
function inspectJar(jarFile) {
  const info = readJarInfo(jarFile)
  return {
    path: jarFile,
    bytes: info.bytes,
    sha256: info.sha256,
    zipValid: info.zipValid,
    manifestVersion: info.manifestVersion,
    implementationVersion: info.implementationVersion,
    springBootVersion: info.springBootVersion,
    gitRevision: info.gitRevision,
    buildTime: info.buildTime,
    startClass: info.startClass,
    entryCount: info.entryCount,
    error: info.error || ''
  }
}

/* ---------------- 生成 electron-builder 配置 ---------------- */

function buildBuilderConfig() {
  const base = pkg.build || {}
  const config = JSON.parse(JSON.stringify(base))
  config.directories = { ...(base.directories || {}), output: path.relative(ROOT, outDir) }
  // 变体资源一律走 extraResources / 不进 asar；files 只包含应用代码与前端产物。
    config.files = ['dist/**/*', 'electron/**/*', 'build/icon.ico', 'build/icon.png', 'package.json']
  delete config.asarUnpack
  config.extraResources = [
    { from: 'build/icon.ico', to: 'icon.ico' },
    ...(variant === 'local-server' ? [
    { from: 'bin/jre', to: 'bin/jre' },
    { from: 'bin/qqmusic-verified', to: 'bin/qqmusic-verified', filter: ['**/*', '!upstream/pip-install-report.json', '!python/Lib/site-packages/**/direct_url.json', '!python/Lib/site-packages/bin/**'] },
    { from: path.join(serverBuildDir, 'server.jar'), to: 'bin/server.jar' },
    { from: 'bin/netease-api.exe', to: 'bin/netease-api.exe' },
    { from: 'bin/netease-api-NOTICE.txt', to: 'bin/netease-api-NOTICE.txt' },
    { from: 'bin/lyrics-glass.exe', to: 'bin/lyrics-glass.exe' },
    { from: 'NETEASE-API-LICENSE.txt', to: 'bin/netease-api-LICENSE.txt' }
    ] : [])
  ]
  config.win = {
    ...(base.win || {}),
    artifactName: `MusicParty-${pkg.version}-${variant}-win-\${arch}.\${ext}`
  }
  config.portable = {
    ...(base.portable || {}),
    artifactName: `MusicParty-${pkg.version}-${variant}-portable-\${arch}.\${ext}`
  }
  config.nsis = {
    ...(base.nsis || {}),
    artifactName: `MusicParty-${pkg.version}-${variant}-setup-\${arch}.\${ext}`
  }
  return config
}

/* ---------------- 变体资源门禁 ---------------- */

function verifyVariantResources({ unpacked, asarEntries }) {
  const checks = {
    variant,
    binInAsar: false,
    jreJarInAsar: false,
    resourcesBinPresent: false,
    jreExePresent: false,
    serverJarPresent: false,
    jreRuns: false,
    jreMajor: null,
    jarZipValid: false,
    jarManifestVersion: ''
  }
  const binAsarEntries = asarEntries.filter((entry) => /^\/bin(\/|$)/i.test(entry))
  checks.binInAsar = binAsarEntries.length > 0
  checks.jreJarInAsar = asarEntries.some((entry) => /(?:^|\/)(?:jre|server\.jar)(?:\/|$)/i.test(entry))

  const resourcesBin = path.join(unpacked, 'resources', 'bin')
  checks.resourcesBinPresent = fs.existsSync(resourcesBin)

  if (variant === 'remote') {
    // 远程精简包：绝不能带本地服务资源（asar、resources/bin、asar.unpacked 都不允许）。
    const unpackedBin = path.join(unpacked, 'resources', 'app.asar.unpacked', 'bin')
    const offenders = []
    if (checks.binInAsar) offenders.push('app.asar 内含 bin/')
    if (fs.existsSync(resourcesBin)) offenders.push('resources/bin 存在')
    if (fs.existsSync(unpackedBin)) offenders.push('app.asar.unpacked/bin 存在')
    if (checks.jreJarInAsar) offenders.push('asar 内含 jre/server.jar 条目')
    if (offenders.length > 0) {
      throw new Error(`[variant:remote] 远程精简包不得包含本地服务资源：${offenders.join('；')}`)
    }
    return checks
  }

  // local-server：资源必须在 resources/bin 下，且真正可执行。
  const javaExe = path.join(resourcesBin, 'jre', 'bin', 'java.exe')
  const jarFile = path.join(resourcesBin, 'server.jar')
  checks.jreExePresent = fs.existsSync(javaExe)
  checks.serverJarPresent = fs.existsSync(jarFile)
  checks.neteaseApiPresent = fs.existsSync(path.join(resourcesBin, 'netease-api.exe'))
  if (!checks.resourcesBinPresent) throw new Error('[variant:local-server] 缺少 resources/bin（extraResources 未复制）')
  if (!checks.jreExePresent) throw new Error('[variant:local-server] 缺少 resources/bin/jre/bin/java.exe')
  if (!checks.serverJarPresent) throw new Error('[variant:local-server] 缺少 resources/bin/server.jar')
  if (!checks.neteaseApiPresent) throw new Error('[variant:local-server] 缺少 resources/bin/netease-api.exe，请准备官方 Windows API 资源')
  if (!fs.existsSync(path.join(resourcesBin, 'qqmusic-verified', 'python', 'python.exe')) || !fs.existsSync(path.join(resourcesBin, 'qqmusic-verified', 'upstream', 'source', 'web', 'run.py'))) {
    throw new Error('[variant:local-server] QQ 音乐运行时不完整')
  }
  checks.neteaseApiSha256 = sha256File(path.join(resourcesBin, 'netease-api.exe'))
  if (checks.neteaseApiSha256.toLowerCase() !== 'b42124b5cbf2b128cf55fe3f0b17a601fb705ffdfd0d36f7d85829914edc6263') {
    throw new Error('内置网易云 API 与已固定的官方 4.36.1 SHA256 不一致')
  }
  if (checks.binInAsar) throw new Error('[variant:local-server] bin/ 不应重复打进 app.asar（只应走 extraResources）')

  // 用打包内 JRE 实际运行 -version，确认可启动且满足 Java 21+。
  const versionResult = spawnSync(javaExe, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  const versionOutput = `${(versionResult && versionResult.stdout) || ''}\n${(versionResult && versionResult.stderr) || ''}`
  const parsed = parseJavaVersionOutput(versionOutput)
  checks.jreRuns = Boolean(parsed.version)
  checks.jreMajor = parsed.major
  checks.jreVersion = parsed.version
  if (!checks.jreRuns) {
    throw new Error(
      `[variant:local-server] 内置 JRE 无法运行：exit=${versionResult && versionResult.status} ${String((versionResult && versionResult.error && versionResult.error.message) || versionOutput.slice(-300))}`
    )
  }
  if (checks.jreMajor == null || checks.jreMajor < JRE_REQUIRED_MAJOR) {
    throw new Error(`[variant:local-server] 内置 JRE 版本过低：${checks.jreVersion || checks.jreMajor}（需要 Java ${JRE_REQUIRED_MAJOR}+）`)
  }

  const jarInfo = inspectJar(jarFile)
  checks.jarZipValid = jarInfo.zipValid
  checks.jarManifestVersion = jarInfo.manifestVersion
  checks.jarSpringBootVersion = jarInfo.springBootVersion
  checks.jarGitRevision = jarInfo.gitRevision
  checks.jarBuildTime = jarInfo.buildTime
  checks.serverJarSha256 = jarInfo.sha256
  checks.serverJarBytes = jarInfo.bytes
  if (!jarInfo.zipValid) throw new Error('[variant:local-server] resources/bin/server.jar 不是合法 JAR（ZIP 头校验失败）')
  return checks
}

function parseJavaVersionOutput(text) {
  const raw = String(text || '')
  const quoted = /(?:openjdk|java)\s+version\s+"([^"]+)"/i.exec(raw)
  const spec = /java\.specification\.version\s*=\s*"?([\w.]+)"?/.exec(raw)
  const version = (quoted && quoted[1]) || (spec && spec[1]) || ''
  const match = /^(\d+)(?:\.(\d+))?/.exec(version)
  let major = null
  if (match) {
    const first = Number(match[1])
    major = first === 1 && match[2] != null ? Number(match[2]) : first
  }
  return { version, major }
}

/* ---------------- 产物收集 ---------------- */

function collectArtifacts() {
  const artifacts = []
  if (!fs.existsSync(outDir)) return artifacts
  for (const name of readDataDirSafe(outDir)) {
    const full = path.join(outDir, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch (_) {
      continue
    }
    if (!stat.isFile()) continue
    if (!/\.(exe|blockmap)$/i.test(name)) continue
    artifacts.push({ name, path: full, bytes: stat.size, sha256: sha256File(full) })
  }
  return artifacts
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log(`[pack] mode=${mode} variant=${variant}`)
  console.log(`[pack] root=${ROOT}`)
  console.log(`[pack] out =${path.relative(ROOT, outDir)}`)
  console.log(`[pack] log =${path.relative(ROOT, logFile)}`)
  mustExist(VITE_BIN, '请先执行 npm install')
  mustExist(BUILDER_BIN, '请先执行 npm install --save-dev electron-builder')
  // Reserve the output atomically. Existing folders may contain an earlier release.
  fs.mkdirSync(path.dirname(outRoot), { recursive: true })
  try { fs.mkdirSync(outRoot) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`输出目录已存在，请指定新目录：${outRoot}`)
    throw error
  }
  fs.mkdirSync(logDir)

  // 0) 变体资源预检（在耗时构建前失败，避免产出错误包）
  const jreInfo = readBundledJreInfo()
  let serverJarInfo = null
  let serverBuildReceipt = null
  if (variant === 'local-server') {
    const javaExe = path.join(ROOT, 'bin', 'jre', 'bin', 'java.exe')
    const jarFile = path.join(serverBuildDir, 'server.jar')
    if (!fs.existsSync(javaExe)) {
      throw new Error('local-server 变体需要 bin/jre/bin/java.exe：请先运行 npm run resources:prepare（下载 Adoptium Temurin JRE 21）')
    }
    if (!fs.existsSync(jarFile)) {
      throw new Error('缺少服务端 JAR：请运行 build-server.ps1 并通过 --server-build 指向新构建目录')
    }
    const neteaseExe = path.join(ROOT, 'bin', 'netease-api.exe')
    const neteaseNotice = path.join(ROOT, 'bin', 'netease-api-NOTICE.txt')
    if (!fs.existsSync(neteaseExe) || !fs.existsSync(neteaseNotice)) throw new Error('缺少网易云 API 资源或 NOTICE，请先运行 node scripts/prepare-netease-resource.cjs')
    if (!fs.existsSync(path.join(ROOT, 'bin', 'lyrics-glass.exe'))) throw new Error('缺少桌面歌词原生玻璃模块：请从 native/lyrics-glass.c 构建 bin/lyrics-glass.exe')
    const glassReceipt = readJsonSafe(path.join(ROOT, 'bin', 'lyrics-glass-build.json'))
    const glassSource = path.join(ROOT, 'native', 'lyrics-glass.c')
    if (!glassReceipt || !fs.existsSync(glassSource) || glassReceipt.target !== 'win32-x64' || glassReceipt.sourceSha256 !== sha256File(glassSource) || glassReceipt.binarySha256 !== sha256File(path.join(ROOT, 'bin', 'lyrics-glass.exe'))) throw new Error('原生玻璃模块与源码或构建记录不匹配，请运行 node scripts/build-lyrics-glass.cjs 重新构建')
    if (sha256File(neteaseExe).toLowerCase() !== 'b42124b5cbf2b128cf55fe3f0b17a601fb705ffdfd0d36f7d85829914edc6263') throw new Error('网易云 API 校验失败')
    if (!fs.existsSync(path.join(ROOT, 'NETEASE-API-LICENSE.txt'))) throw new Error('缺少网易云 API 许可证')
    serverJarInfo = inspectJar(jarFile)
    if (!serverJarInfo.zipValid) throw new Error('bin/server.jar 不是合法 JAR（ZIP 头校验失败）')
    const receipt = readJsonSafe(path.join(serverBuildDir, 'server-build.json'))
    // 0.9.7 changes the desktop only and deliberately reuses the 0.9.6 server.
    // Preserve its original build receipt rather than claiming it was rebuilt.
    const reusedServer = pkg.version === '0.9.7' && receipt?.version === '0.9.6' &&
      receipt.sourceDigest === 'A71D1E4BECA20CEF1D79C112B56ED44BC251B5C944F3BB858776409E1FC4D87C' &&
      receipt.sha256 === '1E9AD02D3F3CB3714B32AF04C64B2032893843F0FC18CE2970925253C3AAC99A'
    if (!receipt || receipt.webIncluded !== true || receipt.sha256 !== serverJarInfo.sha256 ||
        (!reusedServer && (receipt.version !== pkg.version || receipt.sourceDigest !== sourceDigest(ROOT)))) {
      throw new Error('服务端构建记录缺失或与当前源码、版本、JAR 不一致；请从当前源码重新构建服务端')
    }
    serverBuildReceipt = receipt
    if (reusedServer) console.log('[pack] 复用 0.9.6 服务端制品及原始构建记录，未重新构建服务端')
    console.log(
      `[pack] 内置资源：JRE ${jreInfo ? jreInfo.implementorVersion || jreInfo.version : '未知'}` +
        `；server.jar ${formatBytes(serverJarInfo.bytes)} SHA256=${serverJarInfo.sha256.slice(0, 16)}…`
    )
  } else {
    // 远程精简包：即使仓库里存在 bin/ 也不打包（files 白名单已排除），这里只做提示。
    const hasBin = fs.existsSync(path.join(ROOT, 'bin'))
    console.log(`[pack] 远程精简包：不包含 bin/（仓库 bin/ 存在=${hasBin}，会被忽略）`)
  }

  // 1) 图标：缺失时自动生成（已存在则直接复用，保证构建可重复）。
  if (!fs.existsSync(ICON_FILE)) {
    await run('pack-icon (生成 build/icon.ico)', process.execPath, [path.join(__dirname, 'pack-icon.cjs')])
  } else {
    console.log(`[pack] 使用已有图标 ${path.relative(ROOT, ICON_FILE)}`)
  }

  // 2) 前置门禁 + 前端产物（build 命令本身只做 vite build；发布门禁在这里）。
  await run('release-check (candidate preflight)', process.execPath, [CANDIDATE_CHECK_SCRIPT])
  await run('release-check (source)', process.execPath, [CHECK_SCRIPT])
  if (!skipBuild) {
    await run('vite build', process.execPath, [VITE_BIN, 'build'])
  } else {
    console.log('[pack] --skip-build：复用已有 dist/')
  }
  const indexHtml = path.join(ROOT, 'dist', 'index.html')
  if (!fs.existsSync(indexHtml)) throw new Error('缺少 dist/index.html（vite build 未产出）')
  await run('release-check (dist)', process.execPath, [CHECK_SCRIPT, '--dist'])

  // 3) electron-builder（完整配置写入 out/logs，不依赖 package.json 中变体字段）。
  const builderConfig = buildBuilderConfig()
  fs.writeFileSync(configFile, `${JSON.stringify(builderConfig, null, 2)}\n`, 'utf8')
  const builderArgs = ['--win']
  if (mode === 'dir') builderArgs.push('--dir')
  builderArgs.push('--config', configFile, '--publish', 'never')
  if (env.MP_PACK_ELECTRON_DIST !== '0' && fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
    builderArgs.push(`--config.electronDist=${path.relative(ROOT, ELECTRON_DIST).replace(/\\/g, '/')}`)
    console.log('[pack] 复用本地 Electron 发行版（electronDist=node_modules/electron/dist）')
  }
  await run(`electron-builder ${mode} ${variant}`, process.execPath, [BUILDER_BIN, ...builderArgs])

  // 4) 产物检查 + 变体门禁
  const executableName = pkg.build?.executableName || pkg.build?.productName || 'Music Party'
  const exe = path.join(unpackedDir, `${executableName}.exe`)
  if (!fs.existsSync(exe)) throw new Error(`构建结束但未找到 ${path.relative(ROOT, exe)}`)
  const asarPath = path.join(unpackedDir, 'resources', 'app.asar')
  if (!fs.existsSync(asarPath)) throw new Error(`构建结束但未找到 ${path.relative(ROOT, asarPath)}`)
  const asarEntries = asar.listPackage(asarPath).map((entry) => String(entry).replace(/\\/g, '/'))
  const requiredEntries = [
    '/dist/index.html',
    '/electron/main.cjs',
    '/electron/launcher.cjs',
    '/electron/launcher-secrets.cjs',
    '/electron/http-bridge.cjs',
    '/package.json'
  ]
  for (const required of requiredEntries) {
    if (!asarEntries.includes(required)) throw new Error(`app.asar 缺少必需文件：${required}`)
  }
  const checks = verifyVariantResources({ unpacked: unpackedDir, asarEntries })
  const unpackedSize = dirSize(unpackedDir)
  const asarSize = fs.statSync(asarPath).size
  const exeSha256 = sha256File(exe)

  // 5) 清单（pack-manifest.json 追加本次构建）
  // 目录版只记录 win-unpacked；安装包清单只在 --win 模式收集（避免目录版误报旧 exe）。
  const artifacts = mode === 'win' ? collectArtifacts() : []
  const resourceMeta = readJsonSafe(RESOURCE_META_FILE)
  const manifestEntry = {
    variant,
    mode,
    version: pkg.version,
    productName: pkg.build ? pkg.build.productName : 'Music Party',
    builtAt: new Date().toISOString(),
    outDir: path.relative(ROOT, outDir).replace(/\\/g, '/'),
    unpackedDir: path.relative(ROOT, unpackedDir).replace(/\\/g, '/'),
    electron: pkg.devDependencies ? pkg.devDependencies.electron : '',
    unpacked: { files: unpackedSize.files, bytes: unpackedSize.bytes },
    asar: {
      path: path.relative(ROOT, asarPath).replace(/\\/g, '/'),
      bytes: asarSize,
      sha256: sha256File(asarPath),
      entriesChecked: requiredEntries.length,
      hasBin: checks.binInAsar
    },
    exe: { path: path.relative(ROOT, exe).replace(/\\/g, '/'), bytes: fs.statSync(exe).size, sha256: exeSha256 },
    checks,
    bundledResources:
      variant === 'local-server'
        ? {
            jre: {
              path: 'resources/bin/jre',
              version: (jreInfo && (jreInfo.implementorVersion || jreInfo.version)) || checks.jreVersion || '',
              source: resourceMeta?.jre?.source || '未记录来源',
              downloadUrl: resourceMeta?.jre?.url || null,
              zipSha256: (resourceMeta && resourceMeta.jre && resourceMeta.jre.sha256) || null,
              zipFile: null,
              packagedSha256: null
            },
            neteaseApi: {
              path: 'resources/bin/netease-api.exe',
              version: resourceMeta?.neteaseApi?.version || '4.36.1',
              sha256: checks.neteaseApiSha256,
              source: resourceMeta?.neteaseApi?.url || 'Official NeteaseCloudMusicApiEnhanced release'
            },
            serverJar: {
              path: 'resources/bin/server.jar',
              bytes: serverJarInfo ? serverJarInfo.bytes : null,
              sha256: serverJarInfo ? serverJarInfo.sha256 : null,
              manifestVersion: serverJarInfo ? serverJarInfo.manifestVersion : '',
              springBootVersion: serverJarInfo ? serverJarInfo.springBootVersion : '',
              gitRevision: serverBuildReceipt?.gitRevision || '',
              sourceDigest: serverBuildReceipt?.sourceDigest || '',
              sourceDirty: serverBuildReceipt?.dirty ?? null,
              buildTime: serverJarInfo ? serverJarInfo.buildTime : '',
              startClass: serverJarInfo ? serverJarInfo.startClass : '',
              source: 'locally supplied server.jar'
            }
          }
        : null,
    artifacts,
    log: path.relative(ROOT, logFile).replace(/\\/g, '/'),
    builderConfig: path.relative(ROOT, configFile).replace(/\\/g, '/')
  }
  const existingManifest = readJsonSafe(manifestFile) || { runs: [] }
  const runs = Array.isArray(existingManifest.runs) ? existingManifest.runs : []
  runs.push(manifestEntry)
  fs.writeFileSync(manifestFile, `${JSON.stringify({ updatedAt: new Date().toISOString(), runs }, null, 2)}\n`, 'utf8')

  // 6) 输出摘要
  console.log('\n[pack] ✔ 构建完成')
  console.log(`[pack]   变体      ${variant}（${mode === 'dir' ? '目录版' : '安装包'}）`)
  console.log(`[pack]   解包目录  ${path.relative(ROOT, unpackedDir)} = ${unpackedSize.files} 个文件 / ${formatBytes(unpackedSize.bytes)}`)
  console.log(`[pack]   app.asar  ${formatBytes(asarSize)} entries=${asarEntries.length} bin=${checks.binInAsar}`)
  console.log(`[pack]   exe       ${path.relative(ROOT, exe)} SHA256=${exeSha256}`)
  if (checks.variant === 'local-server') {
    console.log(
      `[pack]   内置资源  JRE=${checks.jreVersion || '?'}（major ${checks.jreMajor}）；jar=${formatBytes(checks.serverJarBytes || 0)} SHA256=${(checks.serverJarSha256 || '').slice(0, 16)}… zipValid=${checks.jarZipValid}`
    )
  } else {
    console.log('[pack]   内置资源  无（remote 远程精简包）')
  }
  if (artifacts.length > 0) {
    console.log('[pack]   安装包：')
    for (const artifact of artifacts) {
      console.log(`[pack]     ${path.relative(ROOT, artifact.path)}  ${formatBytes(artifact.bytes)}  SHA256=${artifact.sha256}`)
    }
  }
  console.log(`[pack]   清单      ${path.relative(ROOT, manifestFile)}`)
  console.log(`[pack]   日志      ${path.relative(ROOT, logFile)}`)
  console.log(`[pack]   下一步冒烟 node scripts/pack-shot.cjs --variant ${variant} --out ${path.relative(ROOT, outRoot)}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[pack] ✖ 打包失败：${error?.message || error}`)
    if (error?.stack) console.error(error.stack)
    console.error(`[pack] 完整日志：${path.relative(ROOT, logFile)}`)
    process.exit(1)
  })
}

module.exports = {
  dirSize,
  formatBytes,
  sha256File,
  inspectJar,
  parseJavaVersionOutput,
  verifyVariantResources,
  buildBuilderConfig
}

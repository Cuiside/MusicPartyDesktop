'use strict'

/**
 * 准备 local-server 变体所需的内置资源（bin/jre + bin/server.jar）。
 *
 *   node scripts/prepare-local-resources.cjs [--jar <server.jar>] [--force]
 *
 * JRE 来源（按优先级）：
 *   1. --jre-zip <zip> / 环境变量 MP_JRE_ZIP：已有的 Adoptium Temurin JRE 21 zip；
 *   2. 从 api.adoptium.net 下载 latest/21/ga/windows/x64/jre/hotspot/normal/eclipse
 *      （307 到 GitHub Release；网络慢时请重试或手动下载后用 MP_JRE_ZIP 指定）；
 *   3. 下载失败时用本机 JDK25 的 jlink 生成最小运行时（仍是 Java 25 ≥ 21，会在
 *      .musicparty-resources.json / pack-manifest 中如实标记为 jlink/JRE25）。
 *
 * server.jar：
 *   --jar <path>（最终应由 server-fixer 产出，Java 21+ / class 65）或环境变量 MP_SERVER_JAR；
 *   都没有但 bin/server.jar 已存在时保持不动。
 *
 * 产物：
 *   bin/jre/…            Windows JRE 目录（bin/java.exe + legal/ + release）
 *   bin/server.jar       服务端 JAR（SHA256 记录）
 *   .musicparty-resources.json  资源来源元数据（已 gitignore，供 pack-manifest 引用）
 *
 * 本脚本不修改 git 跟踪的小文件；bin/ 下的大资源已被 .gitignore 忽略。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { readJarInfo } = require('./lib/jar-inspect.cjs')

const ROOT = path.resolve(__dirname, '..')
const BIN_DIR = path.join(ROOT, 'bin')
const JRE_DIR = path.join(BIN_DIR, 'jre')
const JAR_FILE = path.join(BIN_DIR, 'server.jar')
const META_FILE = path.join(ROOT, '.musicparty-resources.json')

const ADOPTIUM_URL =
  'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse'
const JLink_MODULES = [
  'java.base',
  'java.logging',
  'java.naming',
  'java.management',
  'java.instrument',
  'java.xml',
  'jdk.unsupported',
  'java.security.jgss',
  'java.security.sasl',
  'jdk.crypto.ec',
  'java.desktop',
  'java.sql',
  'java.net.http',
  'java.prefs'
].join(',')

const argv = process.argv.slice(2)

function readFlag(name, fallback) {
  const index = argv.indexOf(name)
  if (index < 0) return fallback
  const value = argv[index + 1]
  return value == null || value.startsWith('--') ? fallback : value
}

const force = argv.includes('--force')
const jreOnly = argv.includes('--jre-only')
const jarArg = readFlag('--jar', process.env.MP_SERVER_JAR || '')
const zipArg = readFlag('--jre-zip', process.env.MP_JRE_ZIP || '')

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch (_) {
    return false
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex').toUpperCase()
}

function formatMB(bytes) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function readReleaseVersion(jreDir) {
  const releaseFile = path.join(jreDir, 'release')
  const text = fs.existsSync(releaseFile) ? fs.readFileSync(releaseFile, 'utf8') : ''
  const read = (key) => {
    const match = new RegExp(`${key}="?([^"\\r\\n]+)"?`).exec(text)
    return match ? match[1].trim() : ''
  }
  return {
    version: read('JAVA_VERSION'),
    implementorVersion: read('IMPLEMENTOR_VERSION'),
    implementor: read('IMPLEMENTOR'),
    imageType: read('IMAGE_TYPE')
  }
}

function javaMajor(jreDir) {
  const javaExe = path.join(jreDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  const result = spawnSync(javaExe, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  const output = `${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`
  const match = /(?:openjdk|java)\s+version\s+"([^"]+)"/i.exec(output)
  const version = match ? match[1] : ''
  const majorMatch = /^(\d+)/.exec(version)
  let major = majorMatch ? Number(majorMatch[1]) : null
  if (major === 1) {
    const second = /^1\.(\d+)/.exec(version)
    major = second ? Number(second[1]) : major
  }
  return { version, major, javaExe }
}

function expandZip(zipFile, destination) {
  fs.mkdirSync(destination, { recursive: true })
  if (process.platform === 'win32') {
    // Windows 10+ 自带 bsdtar，可直接解压 zip（比 PowerShell Expand-Archive 快且无进度噪音）。
    execFileSync('tar', ['-xf', zipFile, '-C', destination], { windowsHide: true, stdio: 'ignore', timeout: 300000 })
    return
  }
  const tool = process.platform === 'darwin' ? 'unzip' : 'unzip'
  execFileSync(tool, ['-q', zipFile, '-d', destination], { stdio: 'ignore', timeout: 300000 })
}

function findExtractedJre(root) {
  const direct = path.join(root, 'bin', 'java.exe')
  if (isFile(direct) || isFile(path.join(root, 'bin', 'java'))) return root
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = findExtractedJre(path.join(root, entry.name))
    if (candidate) return candidate
  }
  return ''
}

/** Windows 上 rename 目录偶尔被索引/杀软占用（EPERM）：退化为递归复制后删除。 */
function moveDir(source, target) {
  try {
    fs.renameSync(source, target)
    return
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY', 'EXDEV'].includes(error && error.code)) throw error
    console.warn(`[resources] rename 失败（${error.code}），改用递归复制：${path.basename(source)}`)
    fs.cpSync(source, target, { recursive: true, force: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
}

async function downloadZip(target) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000)
  try {
    console.log(`[resources] 下载 Adoptium Temurin JRE 21：${ADOPTIUM_URL}`)
    const startedAt = Date.now()
    const response = await fetch(ADOPTIUM_URL, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(target, buffer)
    console.log(
      `[resources] 下载完成：${target} ${formatMB(buffer.length)}（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`
    )
    return buffer.length
  } finally {
    clearTimeout(timer)
  }
}

function findJdk25() {
  const candidates = [
    readFlag('--jdk', process.env.MP_JDK_HOME || ''),
    process.env.JAVA_HOME || '',
    'C:\\Program Files\\Microsoft\\jdk-25.0.3.9-hotspot'
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const javaExe = path.join(candidate, 'bin', 'java.exe')
    if (isFile(javaExe)) {
      const version = javaMajor(candidate)
      if (version.major != null && version.major >= 21) return { home: candidate, ...version }
    }
  }
  return null
}

function jlinkFallback() {
  const jdk = findJdk25()
  if (!jdk) throw new Error('未找到 JDK25+，无法用 jlink 生成运行时')
  const jlink = path.join(jdk.home, 'bin', 'jlink.exe')
  if (!isFile(jlink)) throw new Error(`JDK 缺少 jlink：${jlink}`)
  const tempOut = path.join(ROOT, '.tmp-jre-jlink')
  fs.rmSync(tempOut, { recursive: true, force: true })
  console.log(`[resources] 用 jlink 生成最小运行时（基于 ${jdk.version}）：modules=${JLink_MODULES}`)
  execFileSync(
    jlink,
    [
      '--add-modules',
      JLink_MODULES,
      '--strip-debug',
      '--no-man-pages',
      '--no-header-files',
      '--compress=zip-6',
      '--output',
      tempOut
    ],
    { windowsHide: true, stdio: 'inherit', timeout: 300000 }
  )
  fs.rmSync(JRE_DIR, { recursive: true, force: true })
  fs.mkdirSync(BIN_DIR, { recursive: true })
  fs.renameSync(tempOut, JRE_DIR)
  return { source: 'jdk25-jlink', jdkHome: jdk.home, jdkVersion: jdk.version }
}

async function ensureJre(info) {
  const existing = readReleaseVersion(JRE_DIR)
  const existingVersion = existing.implementorVersion || existing.version
  if (!force && isFile(path.join(JRE_DIR, 'bin', 'java.exe')) && isFile(path.join(JRE_DIR, 'release'))) {
    const version = javaMajor(JRE_DIR)
    console.log(`[resources] 已有 bin/jre：${existingVersion}（major ${version.major}），跳过（--force 可重装）`)
    info.jre = {
      ...existing,
      major: version.major,
      source: info.jre && info.jre.source ? info.jre.source : 'existing-bin-jre',
      preparedAt: (info.jre && info.jre.preparedAt) || new Date().toISOString()
    }
    if (version.major == null || version.major < 21) {
      throw new Error(`已有 bin/jre 版本过低（major ${version.major}），请用 --force 重新准备`)
    }
    return
  }

  fs.mkdirSync(BIN_DIR, { recursive: true })
  const tempZip = zipArg || path.join(os.tmpdir(), `mp-adoptium-jre21-${Date.now()}.zip`)
  let zipSha = ''
  try {
    if (zipArg) {
      if (!isFile(zipArg)) throw new Error(`指定的 JRE zip 不存在：${zipArg}`)
      console.log(`[resources] 使用已有 JRE zip：${zipArg}（${formatMB(fs.statSync(zipArg).size)}）`)
    } else if (isFile(tempZip)) {
      console.log(`[resources] 复用已下载 zip：${tempZip}`)
    } else {
      await downloadZip(tempZip)
    }
    zipSha = sha256File(tempZip)
    const extractRoot = path.join(ROOT, '.tmp-jre-extract')
    fs.rmSync(extractRoot, { recursive: true, force: true })
    expandZip(tempZip, extractRoot)
    const extracted = findExtractedJre(extractRoot)
    if (!extracted) throw new Error('JRE zip 解压后找不到 bin/java.exe')
    const version = readReleaseVersion(extracted)
    fs.rmSync(JRE_DIR, { recursive: true, force: true })
    moveDir(extracted, JRE_DIR)
    fs.rmSync(extractRoot, { recursive: true, force: true })
    if (!zipArg) {
      try {
        fs.rmSync(tempZip, { force: true })
      } catch (_) {
        /* ignore */
      }
    }
    const parsed = javaMajor(JRE_DIR)
    if (parsed.major == null || parsed.major < 21) {
      throw new Error(`Adoptium JRE 版本异常（major ${parsed.major}）`)
    }
    info.jre = {
      source: 'adoptium-temurin',
      url: ADOPTIUM_URL,
      zipFile: zipArg || '',
      sha256: zipSha,
      version: version.version,
      implementorVersion: version.implementorVersion,
      implementor: version.implementor,
      major: parsed.major,
      preparedAt: new Date().toISOString()
    }
    console.log(`[resources] bin/jre 就绪：${version.implementorVersion || version.version}（major ${parsed.major}）`)
  } catch (error) {
    console.warn(`[resources] Adoptium JRE 准备失败：${String((error && error.message) || error)}`)
    console.warn('[resources] 回退到本机 JDK25 jlink 最小运行时（仍满足 Java 21+）')
    const generated = jlinkFallback()
    const version = readReleaseVersion(JRE_DIR)
    const parsed = javaMajor(JRE_DIR)
    if (parsed.major == null || parsed.major < 21) {
      throw new Error(`jlink 运行时版本异常（major ${parsed.major}）`)
    }
    info.jre = {
      source: generated.source,
      url: '',
      sha256: '',
      version: version.version,
      implementorVersion: version.implementorVersion || `jlink-${generated.jdkVersion}`,
      implementor: 'jlink (from local JDK)',
      jdkHome: generated.jdkHome,
      major: parsed.major,
      preparedAt: new Date().toISOString(),
      note: '这不是 Adoptium 发行版；是用本机 JDK25 jlink 生成的最小 JRE25 运行时（满足 Java 21+）'
    }
    console.log(`[resources] bin/jre 就绪（jlink）：${version.version}（major ${parsed.major}）`)
  }
}

function ensureJar(info) {
  const target = jarArg ? path.resolve(jarArg) : ''
  if (target) {
    if (!isFile(target)) throw new Error(`指定的 server.jar 不存在：${target}`)
    if (path.resolve(target) !== path.resolve(JAR_FILE)) {
      fs.copyFileSync(target, JAR_FILE)
      console.log(`[resources] 已复制 server.jar：${target} → bin/server.jar`)
    } else {
      console.log('[resources] --jar 已指向 bin/server.jar，无需复制')
    }
  } else if (isFile(JAR_FILE)) {
    console.log(`[resources] 已有 bin/server.jar：${formatMB(fs.statSync(JAR_FILE).size)}（--jar 可替换）`)
  } else {
    throw new Error('缺少 server.jar：请用 --jar <path> 指定（最终应由 server-fixer 的 Java21+ JAR 产出）')
  }
  const jarInfo = readJarInfo(JAR_FILE)
  const zipValid = jarInfo.zipValid
  if (!zipValid) throw new Error('bin/server.jar 不是合法 JAR（ZIP 头校验失败）')
  info.serverJar = {
    source: target || (info.serverJar && info.serverJar.source) || 'existing-bin-server.jar',
    originalPath: target || (info.serverJar && info.serverJar.originalPath) || '',
    bytes: jarInfo.bytes,
    sha256: jarInfo.sha256,
    zipValid,
    manifestVersion: jarInfo.manifestVersion,
    springBootVersion: jarInfo.springBootVersion,
    gitRevision: jarInfo.gitRevision,
    buildTime: jarInfo.buildTime,
    startClass: jarInfo.startClass,
    entryCount: jarInfo.entryCount,
    preparedAt: new Date().toISOString()
  }
  console.log(
    `[resources] server.jar 就绪：${formatMB(jarInfo.bytes)} SHA256=${jarInfo.sha256}` +
      `${jarInfo.manifestVersion ? `（${jarInfo.manifestVersion}${jarInfo.gitRevision ? ` / git ${jarInfo.gitRevision}` : ''}）` : ''}`
  )
}

async function main() {
  console.log('MusicParty 本地服务资源准备（bin/jre + bin/server.jar）')
  const info = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf8')) : {}
  fs.mkdirSync(BIN_DIR, { recursive: true })
  await ensureJre(info)
  if (!jreOnly) ensureJar(info)
  info.preparedAt = new Date().toISOString()
  fs.writeFileSync(META_FILE, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
  console.log(`[resources] 元数据：${path.relative(ROOT, META_FILE)}`)
  console.log('[resources] ✔ 资源就绪（bin/ 已被 .gitignore 忽略，不会入库）')
}

main().catch((error) => {
  console.error(`[resources] ✖ ${error?.message || error}`)
  process.exit(1)
})

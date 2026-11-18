'use strict'

/**
 * Java 运行时探测与版本兼容性（D-11）。
 *
 * 为什么不能只看文件存在：
 *  - 审计实测：本机 PATH 首个 Java 是 17，server.jar 是 class 65（需要 Java 21+），
 *    旧启动器把「java.exe 文件存在」当成 ready，start 后进程以 UnsupportedClassVersionError
 *    退出码 1 结束。
 *
 * 本模块：
 *  - 执行 `java -XshowSettings:properties -version`（超时 5s，stderr 解析
 *    `java.specification.version`），得到真实版本；
 *  - 要求 major >= 21，返回 {version, major, compatible, lastError};
 *  - 多个候选（配置 / 内置 JRE / JAVA_HOME / PATH）按顺序探测，选第一个兼容者，
 *    并保留其它候选的失败原因供 UI 展示；
 *  - 不 require('electron')，纯 Node 可测，spawn 实现可注入。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const REQUIRED_JAVA_MAJOR = 21
const JAVA_PROBE_TIMEOUT_MS = 5000
const JAVA_PROBE_ARGS = ['-XshowSettings:properties', '-version']
const IS_WINDOWS = process.platform === 'win32'

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

/** 从版本号字符串解析 major：`17.0.20.1`→17、`21`→21、`1.8.0_392`→8。 */
function parseJavaMajor(version) {
  if (!version || typeof version !== 'string') return null
  const text = version.trim().replace(/^["']|["']$/g, '')
  const match = /^(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return null
  const first = Number(match[1])
  if (!Number.isFinite(first)) return null
  if (first === 1 && match[2] != null) {
    const second = Number(match[2])
    return Number.isFinite(second) ? second : null
  }
  return first
}

/**
 * 从 `java -XshowSettings:properties -version` 的输出中解析版本。
 * java -version 输出走 stderr，`-XshowSettings:properties` 也走 stderr；
 * 某些包装器可能把内容写到 stdout，两者都尝试。
 */
function parseJavaProbeOutput(text) {
  const raw = String(text || '')
  let version = ''
  let specification = ''
  const specMatch = /java\.specification\.version\s*=\s*"?([\w.]+)"?/.exec(raw)
  if (specMatch) specification = specMatch[1]
  const runtimeMatch = /java\.runtime\.version\s*=\s*"?([\w.\-+]+)"?/.exec(raw)
  if (runtimeMatch) version = runtimeMatch[1]
  if (!version) {
    // openjdk version "21.0.13" 2026-10-20 LTS
    const quoted = /(?:openjdk|java)\s+version\s+"([^"]+)"/i.exec(raw)
    if (quoted) version = quoted[1]
  }
  const major = parseJavaMajor(version) || parseJavaMajor(specification)
  return { version: version || specification || '', major, specification }
}

function mapSpawnError(error, exe) {
  const code = error && error.code
  if (code === 'ENOENT') return `找不到 Java 可执行文件：${exe}`
  if (code === 'EACCES') return `没有执行权限：${exe}`
  if (code === 'EFTYPE' || code === 'ENOEXEC') return `${exe} 不是可执行文件（请重新选择 java.exe）`
  if (code === 'EINVAL') return `无法执行 ${exe}：路径或参数无效`
  return `无法执行 Java（${exe}）：${String((error && error.message) || error)}`
}

/**
 * 探测单个 Java 可执行文件。
 *
 * @param {string} javaExe
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {typeof spawn} [options.spawnImpl] 测试注入
 * @returns {Promise<{ok: boolean, path: string, version: string, major: number|null,
 *   compatible: boolean, lastError: string|null, timedOut?: boolean, durationMs: number}>}
 */
function probeJava(javaExe, options = {}) {
  const exe = String(javaExe || '')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : JAVA_PROBE_TIMEOUT_MS
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const startedAt = Date.now()
  const base = {
    ok: false,
    path: exe,
    version: '',
    major: null,
    compatible: false,
    lastError: null,
    timedOut: false,
    durationMs: 0
  }
  if (!exe) {
    return Promise.resolve({ ...base, lastError: '未指定 Java 可执行文件' })
  }
  if (!isFile(exe) && !options.allowNonFile) {
    return Promise.resolve({ ...base, lastError: `Java 可执行文件不存在：${exe}` })
  }

  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...base, ...result, durationMs: Date.now() - startedAt })
    }
    let timer = null
    try {
      child = spawnImpl(exe, JAVA_PROBE_ARGS, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      finish({ lastError: mapSpawnError(error, exe) })
      return
    }
    timer = setTimeout(() => {
      base.timedOut = true
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      finish({ lastError: `Java 版本探测超时（>${Math.round(timeoutMs / 1000)}s）：${exe}`, timedOut: true })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    if (child.stdout) child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    if (child.stderr) child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => finish({ lastError: mapSpawnError(error, exe) }))
    child.on('close', (code) => {
      const combined = `${stderr}\n${stdout}`
      const parsed = parseJavaProbeOutput(combined)
      if (!parsed.version && !parsed.major) {
        const tail = combined
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-2)
          .join(' ')
        finish({
          lastError: `无法从 ${path.basename(exe)} 的输出解析 Java 版本${code != null ? `（退出码 ${code}）` : ''}${tail ? `：${tail.slice(0, 160)}` : ''}`
        })
        return
      }
      const compatible = parsed.major != null && parsed.major >= REQUIRED_JAVA_MAJOR
      finish({
        ok: true,
        version: parsed.version,
        major: parsed.major,
        compatible,
        lastError: compatible
          ? null
          : `需要 Java ${REQUIRED_JAVA_MAJOR}+，当前 ${parsed.major == null ? parsed.version : parsed.major}`
      })
    })
  })
}

/**
 * 枚举 Java 候选（只做路径存在性检查，不执行）：
 *  1. 显式配置 javaPath（存在性由调用方检查；配置了但不存在时仍作为唯一候选，便于给明确错误）
 *  2. 内置 bin/jre/bin/java.exe
 *  3. JAVA_HOME/bin/java
 *  4. PATH 中的每一个 java（去重，保留顺序）
 *
 * @returns {Array<{path: string, source: 'configured'|'bundled'|'java-home'|'system'}>}
 */
function discoverJavaCandidates(options = {}) {
  const platform = options.platform || process.platform
  const binary = platform === 'win32' ? 'java.exe' : 'java'
  const env = options.env || process.env
  const checkFile = typeof options.isFile === 'function' ? options.isFile : isFile
  const configured = typeof options.configured === 'string' ? options.configured.trim() : ''
  const bundled = typeof options.bundled === 'string' ? options.bundled.trim() : ''
  const candidates = []
  const seen = new Set()
  const push = (candidate, source) => {
    if (!candidate) return
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ path: candidate, source })
  }

  if (configured) {
    push(configured, 'configured')
    return candidates
  }
  if (bundled) push(bundled, 'bundled')

  const javaHome = String(env.JAVA_HOME || '').trim()
  if (javaHome) {
    const candidate = path.join(javaHome, 'bin', binary)
    if (checkFile(candidate)) push(candidate, 'java-home')
  }
  const rawPath = env.PATH || env.Path || ''
  for (const dir of String(rawPath).split(path.delimiter)) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    const candidate = path.join(trimmed, binary)
    if (checkFile(candidate)) push(candidate, 'system')
  }
  return candidates
}

/**
 * 解析 Java：按候选顺序探测，选第一个兼容者。
 *
 * @param {object} options
 * @param {string} [options.configured] 显式 javaPath
 * @param {string} [options.bundled] 内置 jre/bin/java 路径
 * @param {object} [options.env]
 * @param {typeof probeJava} [options.probe]
 * @returns {Promise<{found: boolean, path: string, source: string, version: string,
 *   major: number|null, compatible: boolean, lastError: string|null,
 *   candidates: Array<{path: string, source: string, version: string, compatible: boolean,
 *   major: number|null, lastError: string|null}>}>}
 */
async function resolveJava(options = {}) {
  const probe = typeof options.probe === 'function' ? options.probe : (exe) => probeJava(exe, options.probeOptions)
  const candidates = discoverJavaCandidates(options)
  const results = []
  let chosen = null
  for (const candidate of candidates) {
    const result = await probe(candidate.path)
    const record = {
      path: candidate.path,
      source: candidate.source,
      version: result.version || '',
      major: result.major == null ? null : result.major,
      compatible: Boolean(result.compatible),
      lastError: result.lastError || null
    }
    results.push(record)
    if (record.compatible && !chosen) chosen = record
    // 显式配置只有一个候选：即使不兼容也要把结果带出去，不再回退。
    if (candidates.length === 1) break
  }

  if (chosen) {
    return {
      found: true,
      path: chosen.path,
      source: chosen.source,
      version: chosen.version,
      major: chosen.major,
      compatible: true,
      lastError: null,
      candidates: results
    }
  }

  const firstIncompatible = results.find((item) => item.version || item.lastError)
  let lastError = '未找到 Java 运行时（内置 JRE、JAVA_HOME、PATH 与自定义路径均不可用）'
  if (firstIncompatible) {
    if (firstIncompatible.version && !firstIncompatible.compatible) {
      lastError = `需要 Java ${REQUIRED_JAVA_MAJOR}+，当前 ${firstIncompatible.major == null ? firstIncompatible.version : firstIncompatible.major}（${firstIncompatible.path}）`
    } else if (firstIncompatible.lastError) {
      lastError = firstIncompatible.lastError
    }
  }
  const anyCompatible = results.some((item) => item.compatible)
  return {
    found: anyCompatible,
    path: firstIncompatible ? firstIncompatible.path : '',
    source: firstIncompatible ? firstIncompatible.source : 'none',
    version: firstIncompatible && !firstIncompatible.compatible ? firstIncompatible.version : '',
    major: firstIncompatible && !firstIncompatible.compatible ? firstIncompatible.major : null,
    compatible: false,
    lastError,
    candidates: results
  }
}

module.exports = {
  REQUIRED_JAVA_MAJOR,
  JAVA_PROBE_TIMEOUT_MS,
  JAVA_PROBE_ARGS,
  parseJavaMajor,
  parseJavaProbeOutput,
  probeJava,
  discoverJavaCandidates,
  resolveJava,
  isDir,
  isFile
}

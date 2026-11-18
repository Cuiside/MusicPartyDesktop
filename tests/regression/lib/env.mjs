/**
 * Environment resolution + small OS helpers for the MusicParty regression suite.
 *
 * Every value can be overridden from the command line (`node run-all.mjs --jar <path>`)
 * or the environment (`MP_AUDIT_JAR`).  Nothing here touches product state: the server
 * under test always runs on an isolated localhost port with a throw-away data directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REGRESSION_ROOT = path.resolve(HERE, '..')
export const DESKTOP_ROOT = path.resolve(REGRESSION_ROOT, '..', '..')

export const DELIVERY_ROOT = process.env.MP_DELIVERY_ROOT || path.join(os.tmpdir(), 'musicparty-regression')
export const VERIFICATION_ROOT = path.join(DELIVERY_ROOT, 'verification')
export const DOCS_VERIFICATION_ROOT = path.join(DESKTOP_ROOT, 'docs', 'verification')

/** Microsoft OpenJDK 25 (Java 21+ required by the server). */
export const DEFAULT_JAVA = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : ''

/** Deployed 1.3.9 JAR used for the defect-reproduction baseline. */
export const OLD_JAR = process.env.MP_OLD_JAR || ''
export const OLD_JAR_SHA256 = '9BCD9B67B5E50129B3CA234081DD7B451746DC89C4B906F7D43595134DBE2733'

/** New fixed JAR produced by server-fixer (delivered through the Lead). */
export const NEW_JAR = path.join(DELIVERY_ROOT, 'server', 'server.jar')

/**
 * Test ports. 18848/18849/18850 are the Lead-assigned defaults, but other sessions in the
 * same machine occasionally occupy them; `--port-base 18948` / MP_AUDIT_PORT_BASE keeps a
 * run isolated. The actual ports are recorded in each result JSON (env.ports).
 */
const CLI_ARGS = parseArgs()
export const PORT_BASE = Number(CLI_ARGS['port-base'] || process.env.MP_AUDIT_PORT_BASE || 18848)
export const DEFAULT_SERVER_PORT = PORT_BASE
export const UPSTREAM_PORT = PORT_BASE + 1
export const SECOND_SERVER_PORT = PORT_BASE + 2

export const FIXTURE_ADMIN = 'fixture-admin-verify-20261110'
export const FIXTURE_ROOM_PASSWORD = 'fixture-room-pass-20261110'
export const FIXTURE_START_COOKIE = 'MUSIC_U=valid-start-fixture'
export const FIXTURE_UPDATED_COOKIE = 'MUSIC_U=valid-updated-fixture'

/** Parse `--key value` / `--flag` argv pairs into a plain object. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key.includes('=')) {
      const idx = key.indexOf('=')
      out[key.slice(0, idx)] = key.slice(idx + 1)
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

/** Resolve the server JAR under test: CLI > env > new delivery > old baseline. */
export function resolveJar(args = {}) {
  const candidate = args.jar || process.env.MP_AUDIT_JAR || (fs.existsSync(NEW_JAR) ? NEW_JAR : OLD_JAR)
  if (!candidate) throw new Error('Set --jar or MP_AUDIT_JAR explicitly')
  return path.resolve(String(candidate))
}

/** Resolve the Java executable: CLI > env > bundled Microsoft JDK 25. */
export function resolveJava(args = {}) {
  const candidate = args.java || process.env.MP_AUDIT_JAVA || DEFAULT_JAVA
  if (!candidate) throw new Error('Set --java, MP_AUDIT_JAVA, or JAVA_HOME explicitly')
  return path.resolve(String(candidate))
}

export function isOldJar(jarPath) {
  try {
    return sha256File(jarPath) === OLD_JAR_SHA256
  } catch {
    return Boolean(OLD_JAR) && path.resolve(jarPath) === path.resolve(OLD_JAR)
  }
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex').toUpperCase()
}

export function tmpRoot(prefix = 'mp-regression-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function nowIso() {
  return new Date().toISOString()
}

/** Run a one-time `fn` if the port accepts TCP connections (listener present). */
export function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Fail early when a suite's dedicated port is already taken. */
export async function assertPortFree(port, label = '') {
  if (await isPortListening(port)) {
    throw new Error(`端口 ${port} 已被占用（${label}）；请先清理监听进程再运行回归测试。`)
  }
}

/** Poll until the TCP port stops accepting connections (after killing a server). */
export async function waitPortFree(port, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!(await isPortListening(port))) return true
    await sleep(100)
  }
  return !(await isPortListening(port))
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll `fn` until truthy; returns the truthy value or null on timeout. */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = await fn()
    } catch {
      value = null
    }
    if (value) return value
    if (Date.now() - started >= timeoutMs) return null
    await sleep(intervalMs)
  }
}

/** Safe command output helper; never throws. */
export async function run(command, args, options = {}) {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error?.message || error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Deterministic fixture UUID-ish identifier for this run (never a real credential). */
export function fixtureId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`
}

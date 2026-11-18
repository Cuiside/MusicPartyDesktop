/**
 * Isolated Java server lifecycle manager.
 *
 * The JAR under test is always launched with:
 *  - 127.0.0.1:<isolated port>
 *  - a throw-away data directory supplied by the caller
 *  - a synthetic NetEase upstream base URL
 *  - fixture admin password / cookies (never real credentials)
 *
 * Killing the process on Windows is a hard TerminateProcess, so persistence tests wait
 * for the documented flush/write path before calling stop().
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertPortFree, ensureDir, isPortListening, sleep, waitFor, waitPortFree } from './env.mjs'
import { get } from './http.mjs'

const MAX_LOG_CHARS = 2 * 1024 * 1024

/**
 * @param {{
 *   jar: string, java: string, port: number, dataDir: string, upstreamPort: number,
 *   adminPassword?: string, neteaseCookie?: string, args?: string[],
 *   readyTimeoutMs?: number, label?: string
 * }} options
 */
export async function startServer(options) {
  const {
    jar,
    java,
    port,
    dataDir,
    upstreamPort,
    adminPassword,
    neteaseCookie,
    args = [],
    extraEnv = {},
    readyTimeoutMs = 120000,
    label = `server:${port}`
  } = options

  await assertPortFree(port, label)
  ensureDir(dataDir)

  const javaArgs = [
    '-jar',
    jar,
    '--server.address=127.0.0.1',
    `--server.port=${port}`,
    `--app.music-api.netease.base-url=http://127.0.0.1:${upstreamPort}`,
    '--app.music-api.queue.persistence-interval-ms=500',
    '--logging.level.root=WARN'
  ]
  if (adminPassword !== undefined) javaArgs.push(`--app.music-api.admin-password=${adminPassword}`)
  if (neteaseCookie !== undefined) javaArgs.push(`--app.music-api.netease.cookie=${neteaseCookie}`)
  javaArgs.push(...args)

  const startedAt = Date.now()
  const child = spawn(java, javaArgs, {
    cwd: dataDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: undefined }
  })

  let log = ''
  const append = (chunk) => {
    log += chunk
    if (log.length > MAX_LOG_CHARS) log = log.slice(-MAX_LOG_CHARS)
  }
  child.stdout?.on('data', (data) => append(String(data)))
  child.stderr?.on('data', (data) => append(String(data)))

  const base = `http://127.0.0.1:${port}`
  const ready = await waitFor(
    async () => {
      if (child.exitCode !== null) return null
      const response = await get(base, '/api/config', { timeoutMs: 2500 })
      return response.status === 200 ? response : null
    },
    { timeoutMs: readyTimeoutMs, intervalMs: 400 }
  )

  const handle = {
    base,
    port,
    dataDir,
    javaArgs,
    child,
    get exitCode() {
      return child.exitCode
    },
    get ready() {
      return Boolean(ready)
    },
    readyResponse: ready,
    startupMs: Date.now() - startedAt,
    logs: () => log,
    /** Persistence-friendly stop: wait `graceMs`, terminate, then confirm the port is free. */
    async stop({ graceMs = 900, timeoutMs = 15000 } = {}) {
      if (child.exitCode !== null) {
        await waitPortFree(port, 3000)
        return
      }
      if (graceMs > 0) await sleep(graceMs)
      child.kill()
      const exited = await waitFor(() => child.exitCode !== null, { timeoutMs, intervalMs: 100 })
      if (!exited) {
        // Last resort on Windows: terminate the whole process tree.
        await new Promise((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
          killer.on('close', resolve)
          killer.on('error', resolve)
        })
      }
      await waitPortFree(port, timeoutMs)
    },
    /** Stop and relaunch against the same data directory / same arguments. */
    async restart({ graceMs = 900 } = {}) {
      await handle.stop({ graceMs })
      const next = await startServer(options)
      return next
    }
  }

  if (!ready) {
    const tail = log.slice(-4000)
    await handle.stop({ graceMs: 0 })
    throw new Error(`服务器未在 ${readyTimeoutMs}ms 内就绪（端口 ${port}，JAR ${jar}）。日志尾部：\n${tail}`)
  }
  return handle
}

/** Read a JSON file, returning null when missing/corrupt. */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Does a persisted file under the data directory contain a raw fixture secret? */
export function dataDirContainsSecret(dataDir, secret) {
  const matched = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(target)
      } else if (entry.isFile()) {
        let text = ''
        try {
          text = fs.readFileSync(target, 'utf8')
        } catch {
          continue
        }
        if (text.includes(secret)) matched.push(target)
      }
    }
  }
  walk(dataDir)
  return matched
}

/** Wait for the server process/port to disappear (used by run-all cleanup). */
export async function terminateQuietly(handle) {
  try {
    await handle?.stop({ graceMs: 0 })
  } catch {
    /* ignore cleanup failures */
  }
}

/** Is anything listening on this port right now? */
export { isPortListening }

'use strict'
/**
 * Shared helpers for the public-release usability audit.
 *
 *   scripts/usability-capture.cjs  – serial screenshot pass (MP_SHOT + optional MP_EVAL)
 *   scripts/usability-verify.cjs   – one-shot assertions, PASS/FAIL + evidence log
 *
 * Everything is serial: exactly one Electron instance at a time. The scripts can audit
 * either the working tree (default) or a pristine baseline checkout:
 *
 *   node scripts/usability-verify.cjs --repo E:\example-baseline-c7c5594 --tag baseline
 *
 * Environment overrides:
 *   MP_USABILITY_REPO   repo/build to launch (default: parent of this script)
 *   MP_USABILITY_OUT    screenshot root (default: <this repo>/screenshots/usability)
 *   MP_USABILITY_ELECTRON  explicit electron binary (default: repo node_modules electron)
 *
 * Notes for future runs:
 * - electron/main.cjs answers MP_SHOT / MP_EVAL hooks; both force `shot=1` / `eval=1`
 *   query flags that deliberately SUPPRESS the first-launch auto-open logic in App.vue.
 *   A genuine first launch therefore runs a normal app instance and is inspected over
 *   the Chrome DevTools Protocol (--remote-debugging-port), which is what cdp* does.
 * - `ELECTRON_RUN_AS_NODE` is inherited from the harness and MUST be deleted or Electron
 *   runs the main script under plain Node (no window, no renderer).
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')

const DEFAULT_REPO = path.resolve(__dirname, '..')
const DEFAULT_OUT = path.join(DEFAULT_REPO, 'screenshots', 'usability')

function repoRoot() {
  return process.env.MP_USABILITY_REPO ? path.resolve(process.env.MP_USABILITY_REPO) : DEFAULT_REPO
}

function outRoot() {
  return process.env.MP_USABILITY_OUT ? path.resolve(process.env.MP_USABILITY_OUT) : DEFAULT_OUT
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Read the short git HEAD of the audited tree (works for plain checkouts only). */
function gitInfo(repo) {
  const run = (args) => {
    try {
      const { spawnSync } = require('node:child_process')
      const res = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
      return res.status === 0 ? String(res.stdout || '').trim() : ''
    } catch {
      return ''
    }
  }
  return {
    head: run(['rev-parse', '--short', 'HEAD']),
    subject: run(['log', '-1', '--pretty=%s']),
    dirty: run(['status', '--porcelain']) !== ''
  }
}

function electronBinary(repo) {
  if (process.env.MP_USABILITY_ELECTRON) return process.env.MP_USABILITY_ELECTRON
  const inRepo = path.join(repo, 'node_modules', 'electron')
  try {
    return require(inRepo)
  } catch {
    /* fall through */
  }
  return require('electron')
}

function cleanElectronEnv(extra) {
  const env = { ...process.env, ...(extra || {}) }
  delete env.ELECTRON_RUN_AS_NODE
  // Never let an inherited hook change the scenario we are launching.
  for (const key of ['MP_SHOT', 'MP_SHOT_OUT', 'MP_SHOT_VIEW', 'MP_SHOT_EXTRA', 'MP_EVAL', 'MP_EVAL_FILE', 'MP_EVAL_WAIT']) {
    if (!extra || !(key in extra)) delete env[key]
  }
  return env
}

function killTree(childId) {
  return new Promise((resolve) => {
    if (!childId) return resolve()
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(childId), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('close', () => resolve())
      killer.once('error', () => resolve())
    } else {
      try {
        process.kill(-childId, 'SIGKILL')
      } catch {
        resolve()
      }
    }
  })
}

/**
 * Run the packaged app in screenshot mode and wait for it to exit.
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 */
function runShot(options) {
  const repo = options.repo || repoRoot()
  const electron = electronBinary(repo)
  const env = cleanElectronEnv({
    MP_SHOT: '1',
    MP_SHOT_OUT: options.outFile,
    MP_SHOT_WAIT: String(options.wait ?? 2200),
    MP_SHOT_W: String(options.width || 1440),
    MP_SHOT_H: String(options.height || 900),
    ...(options.view ? { MP_SHOT_VIEW: options.view } : {}),
    ...(options.extra ? { MP_SHOT_EXTRA: options.extra } : {})
  })
  let evalFile = null
  if (options.evalCode) {
    const tmp = ensureDir(path.join(os.tmpdir(), 'mp-usability-evals'))
    evalFile = path.join(tmp, `shot-eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.js`)
    fs.writeFileSync(evalFile, String(options.evalCode), 'utf8')
    env.MP_EVAL_FILE = evalFile
    env.MP_EVAL_WAIT = String(options.evalWait ?? 1600)
  }
  const timeoutMs = options.timeoutMs ?? 60000
  return new Promise((resolve) => {
    if (options.outFile) ensureDir(path.dirname(options.outFile))
    const child = spawn(electron, ['.'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (text) => (text.length > 60000 ? text.slice(-60000) : text)
    child.stdout.on('data', (d) => (stdout = cap(stdout + d.toString())))
    child.stderr.on('data', (d) => (stderr = cap(stderr + d.toString())))
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child.pid)
    }, timeoutMs)
    const finish = (code) => {
      clearTimeout(timer)
      if (evalFile) {
        try {
          fs.unlinkSync(evalFile)
        } catch {}
      }
      let result = null
      let evalFailed = null
      for (const line of stdout.split(/\r?\n/)) {
        if (line.includes('[eval] result ')) {
          try {
            result = JSON.parse(line.slice(line.indexOf('[eval] result ') + '[eval] result '.length))
          } catch {
            result = { parseError: line }
          }
        } else if (line.includes('[eval] failed ')) {
          evalFailed = line.slice(line.indexOf('[eval] failed '))
        }
      }
      resolve({ code: code ?? -1, result, evalFailed, stdout, stderr, timedOut })
    }
    child.on('close', (code) => finish(code))
    child.on('error', (error) => {
      stderr += String(error)
      finish(-1)
    })
  })
}

/**
 * Run the app in eval mode: main.cjs executes MP_EVAL_FILE in the renderer after
 * MP_EVAL_WAIT ms and prints `[eval] result <json>` on stdout.
 * @returns {Promise<{code:number, result:any, evalFailed:string|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
function runEval(options) {
  const repo = options.repo || repoRoot()
  const electron = electronBinary(repo)
  const code = String(options.code || 'null')
  const tmp = ensureDir(path.join(os.tmpdir(), 'mp-usability-evals'))
  const evalFile = path.join(tmp, `eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.js`)
  fs.writeFileSync(evalFile, code, 'utf8')
  const env = cleanElectronEnv({
    MP_EVAL_FILE: evalFile,
    MP_EVAL_WAIT: String(options.wait ?? 1500),
    MP_SHOT_W: String(options.width || 1440),
    MP_SHOT_H: String(options.height || 900),
    ...(options.view ? { MP_SHOT_VIEW: options.view } : {}),
    ...(options.extra ? { MP_SHOT_EXTRA: options.extra } : {})
  })
  const timeoutMs = options.timeoutMs ?? Math.max(30000, Number(options.wait ?? 1500) + 30000)
  return new Promise((resolve) => {
    const child = spawn(electron, ['.'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (text) => (text.length > 60000 ? text.slice(-60000) : text)
    child.stdout.on('data', (d) => (stdout = cap(stdout + d.toString())))
    child.stderr.on('data', (d) => (stderr = cap(stderr + d.toString())))
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child.pid)
    }, timeoutMs)
    child.on('close', (code_) => {
      clearTimeout(timer)
      try {
        fs.unlinkSync(evalFile)
      } catch {}
      let result = null
      let evalFailed = null
      for (const line of stdout.split(/\r?\n/)) {
        if (line.includes('[eval] result ')) {
          try {
            result = JSON.parse(line.slice(line.indexOf('[eval] result ') + '[eval] result '.length))
          } catch {
            result = { parseError: line }
          }
        } else if (line.includes('[eval] failed ')) {
          evalFailed = line.slice(line.indexOf('[eval] failed '))
        }
      }
      resolve({ code: code_ ?? -1, result, evalFailed, stdout, stderr, timedOut })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, result: null, evalFailed: String(error), stdout, stderr, timedOut })
    })
  })
}

/* ------------------------------------------------------------------ */
/* Chrome DevTools Protocol: genuine app launch (no automation query)  */
/* ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function httpJson(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'} (${msg.method || ''})`))
        else resolve(msg.result)
      }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
    ws.addEventListener('error', () => {
      this.closed = true
    })
  }

  static async connect(wsUrl, timeoutMs = 8000) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error('CDP connect failed: ' + String(event?.message || event?.type || 'error')))
      })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async eval(expression, timeoutMs = 20000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    )
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      throw new Error(detail.exception?.description || detail.text || 'evaluate failed')
    }
    return result.result ? result.result.value : undefined
  }

  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/**
 * Launch the app like a real user would (no MP_SHOT/MP_EVAL flags), inspect it via CDP,
 * then tear the whole process tree down.
 *
 * @param {{repo?:string,width?:number,height?:number,extra?:string,waitReadyMs?:number,
 *          run:(api:{cdp:Cdp, eval:(expr:string,ms?:number)=>Promise<any>,
 *                    waitFor:(expr:string,ms?:number)=>Promise<boolean>,
 *                    screenshot:(file:string)=>Promise<string>}) => Promise<any>}} options
 */
async function withGenuineApp(options) {
  const repo = options.repo || repoRoot()
  const electron = electronBinary(repo)
  const width = options.width || 1440
  const height = options.height || 900
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-usability-profile-'))
  const port = await freePort()
  const env = cleanElectronEnv({
    MP_SHOT_W: String(width),
    MP_SHOT_H: String(height),
    ...(options.extra ? { MP_SHOT_EXTRA: options.extra } : {})
  })
  const child = spawn(
    electron,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false }
  )
  let stdout = ''
  let stderr = ''
  const cap = (text) => (text.length > 30000 ? text.slice(-30000) : text)
  child.stdout.on('data', (d) => (stdout = cap(stdout + d.toString())))
  child.stderr.on('data', (d) => (stderr = cap(stderr + d.toString())))
  let cdp = null
  try {
    // Wait for the devtools HTTP endpoint and the page target.
    const deadline = Date.now() + (options.startupTimeoutMs || 30000)
    let target = null
    while (Date.now() < deadline) {
      try {
        const list = await httpJson(`http://127.0.0.1:${port}/json/list`)
        target = (list || []).find((t) => t.type === 'page' && /index\.html/i.test(t.url || '')) || (list || []).find((t) => t.type === 'page')
        if (target && target.webSocketDebuggerUrl) break
      } catch {
        /* devtools not up yet */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error('CDP target not found: ' + (stderr.split(/\r?\n/).filter((l) => /error|DevTools/i.test(l)).slice(-3).join(' | ') || 'no diagnostics'))
    }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Runtime.enable').catch(() => {})

    const evalInPage = (expression, timeoutMs) => cdp.eval(expression, timeoutMs)
    const waitFor = async (expression, timeoutMs = 12000) => {
      const stop = Date.now() + timeoutMs
      while (Date.now() < stop) {
        try {
          if (await cdp.eval(expression, 4000)) return true
        } catch {
          /* page may still be reloading */
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    }
    // Wait until Vue mounted and the first frame settled.
    const ready = await waitFor(`!!document.querySelector('.mp-app') && document.readyState === 'complete'`, options.waitReadyMs || 20000)
    if (!ready) throw new Error('app did not mount (window.__mp / .mp-app missing)')
    await new Promise((r) => setTimeout(r, options.settleMs ?? 900))
    const result = await options.run({
      cdp,
      eval: evalInPage,
      waitFor,
      screenshot: (file) => cdp.screenshot(file)
    })
    return { ok: true, result, stdout, stderr }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), stdout, stderr }
  } finally {
    if (cdp) cdp.close()
    try {
      child.kill()
    } catch {}
    await killTree(child.pid)
    await new Promise((r) => setTimeout(r, 300))
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(profile, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fake MusicParty-ish HTTP servers (error-message probes)             */
/* ------------------------------------------------------------------ */

/**
 * Start a throw-away HTTP server used to reproduce error states.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 */
function startFakeServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
            setTimeout(done, 1500)
          })
      })
    })
  })
}

/** A server that claims to be password protected and rejects every password. */
function startWrongPasswordServer() {
  return startFakeServer((req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url.startsWith('/api/auth/status')) return send(200, { hasProtection: true, protected: true })
    if (req.method === 'POST' && req.url.startsWith('/api/auth/verify')) return send(401, { valid: false, message: '房间密码错误' })
    if (req.method === 'GET' && req.url.startsWith('/api/config')) return send(200, {})
    send(404, { message: 'not found' })
  })
}

/** A server that answers every request with an HTML page (definitely not MusicParty). */
function startHtmlServer() {
  return startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>Some random website</title></head><body><h1>Welcome to a normal website</h1></body></html>')
  })
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function textOf(value, limit = 240) {
  const text = String(value == null ? '' : value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

module.exports = {
  DEFAULT_REPO,
  DEFAULT_OUT,
  repoRoot,
  outRoot,
  stamp,
  ensureDir,
  gitInfo,
  electronBinary,
  runShot,
  runEval,
  freePort,
  withGenuineApp,
  startFakeServer,
  startWrongPasswordServer,
  startHtmlServer,
  killTree,
  textOf
}

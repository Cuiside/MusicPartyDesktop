'use strict'
/**
 * 音频引擎冒烟测试（node scripts/audio-smoke.cjs）。
 *
 * 默认流程：
 * 1. 检测 5173：若已有本仓库的 Vite dev server 则复用；否则自己 `createServer` 起一个；
 *    端口被无关进程占用则打印 SKIP 退出 0。
 * 2. 生成临时 eval 脚本：浏览器里合成 1 秒 WAV data URL → 动态 import
 *    `/src/core/audio/engine.js` → setTrack + play，等待 ~900ms 后回传
 *    `{ ready, playing, currentTime, duration, hasAnalyser, fftMax, ... }`。
 * 3. spawn Electron（MP_DEV=1 / MP_EVAL_FILE / MP_EVAL_WAIT=4000 / MP_SHOT=1），
 *    main.cjs 会执行 eval 并把结果打印成 `[eval] result {...}`。
 * 4. 断言 currentTime > 0.2；有分析器时断言 fftMax > 0。打印 PASS/FAIL JSON，退出码 0/1。
 * 5. 清理临时文件、electron、vite。
 *
 * `--extended` 额外跑一轮（多一次 Electron 启动，约 +10s）：
 * - `resolveMediaUrl` 对 http/data/相对 `/media/`/PENDING_DOWNLOAD 的处理；
 * - setVolume/mute 的 0..1 夹取；
 * - 无 CORS 头的本地媒体服务器 → 验证 crossOrigin 失败后的自动回退：
 *   仍有声音、`hasAnalyser === false`、`degraded === 'cors'`、不抛错。
 *
 * 注意：本环境的 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成 Node，必须删除。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PORT = 5173
const ELECTRON_TIMEOUT_MS = 120000
const EXTENDED = process.argv.includes('--extended')

/** 浏览器内 eval 脚本：必须是一个返回 Promise 的表达式，且不含反引号/模板字符串。 */
const BASE_EVAL_SCRIPT = `
(async () => {
  const t0 = performance.now()

  function makeWavDataUrl() {
    const sampleRate = 44100
    const seconds = 1
    const sampleCount = sampleRate * seconds
    const buffer = new ArrayBuffer(44 + sampleCount * 2)
    const view = new DataView(buffer)
    const writeAscii = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    writeAscii(0, 'RIFF')
    view.setUint32(4, 36 + sampleCount * 2, true)
    writeAscii(8, 'WAVE')
    writeAscii(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeAscii(36, 'data')
    view.setUint32(40, sampleCount * 2, true)
    for (let i = 0; i < sampleCount; i++) {
      const fadeIn = Math.min(1, i / 441)
      const fadeOut = Math.min(1, (sampleCount - i) / 441)
      const env = Math.min(fadeIn, fadeOut)
      const sine = Math.sin((2 * Math.PI * 440 * i) / sampleRate)
      const second = Math.sin((2 * Math.PI * 880 * i) / sampleRate) * 0.35
      view.setInt16(44 + i * 2, Math.round((sine * 0.55 + second * 0.25) * env * 32767), true)
    }
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return 'data:audio/wav;base64,' + btoa(binary)
  }

  const result = { ok: false }
  try {
    const mod = await import('/src/core/audio/engine.js')
    const engine = mod.engine || mod.default
    const url = makeWavDataUrl()
    result.dataUrlLength = url.length

    result.loaded = mod.setTrack({ url: url, duration: 1, startAt: 0, crossOrigin: true })
    await new Promise((resolve) => setTimeout(resolve, 120))
    result.playOk = await mod.play()
    await new Promise((resolve) => setTimeout(resolve, 900))

    const bins = mod.getFrequencyBins(64)
    let fftMax = 0
    let fftSum = 0
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] > fftMax) fftMax = bins[i]
      fftSum += bins[i]
    }
    const waveform = mod.getWaveform(32)
    let waveMin = 255
    let waveMax = 0
    for (let i = 0; i < waveform.length; i++) {
      if (waveform[i] < waveMin) waveMin = waveform[i]
      if (waveform[i] > waveMax) waveMax = waveform[i]
    }

    result.ready = engine.ready
    result.playing = engine.playing
    result.currentTime = Math.round(engine.currentTime * 1000) / 1000
    result.duration = engine.duration
    result.hasAnalyser = engine.hasAnalyser
    result.degraded = engine.degraded
    result.error = engine.error
    result.fftMax = fftMax
    result.fftSum = fftSum
    result.bins = bins.length
    result.waveformSpread = waveMax - waveMin
    result.trackCrossOrigin = engine.track ? engine.track.crossOrigin : null
    result.resolvedIsDataUrl = Boolean(engine.track && engine.track.resolvedUrl && engine.track.resolvedUrl.indexOf('data:audio/wav') === 0)
    result.ok = true
  } catch (error) {
    result.thrown = String((error && error.name) || 'Error') + ': ' + String((error && error.message) || error)
  } finally {
    try { (await import('/src/core/audio/engine.js')).destroy() } catch (cleanupError) { /* ignore */ }
    result.evalMs = Math.round(performance.now() - t0)
  }
  return result
})()
`

/**
 * 生成 --extended 用的浏览器 eval 脚本（`__MEDIA_PORT__` 由 Node 侧替换）。
 *
 * @returns {string}
 */
const EXTENDED_EVAL_SCRIPT = `
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const out = { ok: false }
  try {
    const mod = await import('/src/core/audio/engine.js')
    const engine = mod.engine || mod.default
    const round = (value) => Math.round(Number(value) * 1000) / 1000

    out.resolve = {
      absoluteHttps: mod.resolveMediaUrl('https://example.com/a.mp3'),
      relativeWithoutBase: mod.resolveMediaUrl('/media/a.mp3'),
      relativeWithBase: mod.resolveMediaUrl('/media/a.mp3', 'http://127.0.0.1:8080'),
      protocolRelative: mod.resolveMediaUrl('//127.0.0.1:8080/media/a.mp3', 'http://127.0.0.1:8080'),
      pendingDownload: mod.resolveMediaUrl('PENDING_DOWNLOAD'),
      dataUrl: mod.resolveMediaUrl('data:audio/wav;base64,AAAA') ? 'data-url' : null
    }

    out.volume = {
      clampHigh: mod.setVolume(1.7),
      clampLow: mod.setVolume(-3),
      restore: mod.setVolume(1)
    }
    out.mute = { on: mod.mute(true), off: mod.mute(false) }

    out.pendingLoad = mod.setTrack({ url: 'PENDING_DOWNLOAD', duration: 0 })
    out.pendingTrack = engine.track
    out.pendingError = engine.error

    // The room starts playback immediately after setTrack, before a CORS error.
    // The old smoke waited for the fallback first, hiding this race.
    mod.setTrack({ url: 'http://127.0.0.1:__MEDIA_PORT__/tone.wav', duration: 1, crossOrigin: true })
    mod.syncTo(0, true)
    await wait(550)
    out.immediateFallback = {
      fallback: Boolean(engine.track && engine.track.corsFallback),
      playing: engine.playing, currentTime: round(engine.currentTime), error: engine.error
    }
    mod.pause()
    mod.destroy()

    // A browser that refuses to resume AudioContext must fall back to direct audio.
    const NativeAudioContext = window.AudioContext
    window.AudioContext = class {
      constructor() { this.state = 'suspended'; this.destination = {} }
      createAnalyser() { return { fftSize: 0, frequencyBinCount: 1024, connect() {} } }
      createMediaElementSource() { return { connect() {}, disconnect() {} } }
      resume() { return Promise.reject(new Error('fixture suspended context')) }
      close() { this.state = 'closed'; return Promise.resolve() }
    }
    mod.setTrack({ url: 'http://127.0.0.1:__MEDIA_PORT__/tone.wav?case=context', duration: 1, crossOrigin: true })
    mod.syncTo(0, true)
    await wait(550)
    out.suspendedContextFallback = { degraded: engine.degraded, playing: engine.playing, currentTime: round(engine.currentTime) }
    mod.pause(); mod.destroy()
    mod.setTrack({ url: 'http://127.0.0.1:__MEDIA_PORT__/tone.wav?case=context-delayed', duration: 1, crossOrigin: true })
    await wait(350)
    void mod.play()
    await wait(550)
    out.delayedContextFallback = { degraded: engine.degraded, playing: engine.playing, currentTime: round(engine.currentTime) }
    mod.pause(); mod.destroy(); window.AudioContext = NativeAudioContext

    out.corsLoad = mod.setTrack({
      url: 'http://127.0.0.1:__MEDIA_PORT__/tone.wav?case=delayed',
      duration: 1,
      crossOrigin: true
    })
    await wait(1000)
    out.corsFallbackFlag = Boolean(engine.track && engine.track.corsFallback)
    out.corsDegraded = engine.degraded
    out.corsHasAnalyser = engine.hasAnalyser
    out.corsErrorAfterLoad = engine.error
    out.corsPlayOk = await mod.play()
    await wait(1000)
    out.corsReady = engine.ready
    out.corsPlaying = engine.playing
    out.corsCurrentTime = round(engine.currentTime)
    out.corsDuration = engine.duration
    out.corsError = engine.error
    out.corsBins = mod.getFrequencyBins(16).length

    // 频谱条渲染器（reduced-motion 静态帧）：画布上应真正写出像素
    const vizMod = await import('/src/core/audio/visualizer.js')
    const canvas = document.createElement('canvas')
    canvas.style.width = '320px'
    canvas.style.height = '80px'
    document.body.appendChild(canvas)
    const viz = vizMod.createBarsVisualizer(canvas, { engine: engine, bars: 32, reducedMotion: true })
    const status = viz.getStatus()
    const context = canvas.getContext('2d')
    let painted = 0
    if (context) {
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      for (let i = 3; i < image.data.length; i += 4) {
        if (image.data[i] > 0) painted += 1
      }
    }
    out.viz = {
      bars: status.bars,
      reducedMotion: status.reducedMotion,
      hasAnalyser: status.hasAnalyser,
      active: status.active,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      paintedPixels: painted
    }
    viz.destroy()
    canvas.remove()

    out.ok = true
  } catch (error) {
    out.thrown = String((error && error.name) || 'Error') + ': ' + String((error && error.message) || error)
  } finally {
    try { (await import('/src/core/audio/engine.js')).destroy() } catch (cleanupError) { /* ignore */ }
  }
  return out
})()
`

/* ------------------------------------------------------------------------- *
 * 小工具
 * ------------------------------------------------------------------------- */

/**
 * 探测 host:port 是否可建立 TCP 连接。
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
function isPortOpen(host, port, timeout = 800) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeout, () => finish(false))
  })
}

/**
 * 等待 dev server 的 HTTP 端口就绪。
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForHttp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * 判断 5173 上已有的服务是不是本仓库的 Vite dev server（可复用）。
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function canReuseDevServer(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return false
    const html = await res.text()
    return /id=["']app["']/.test(html) || /\/src\/main\.js/.test(html) || /@vite\/client/.test(html)
  } catch {
    return false
  }
}

/**
 * Windows 上强杀进程树（Electron 会派生子进程）。
 *
 * @param {import('node:child_process').ChildProcess | null} child
 * @returns {void}
 */
function killTree(child) {
  if (!child || child.exitCode != null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 从 Electron stdout 里解析 `[eval] result {...}` 行。
 *
 * @param {string} stdout
 * @returns {{ payload: any | null, evalFailed: string | null }}
 */
function parseEvalOutput(stdout) {
  let payload = null
  let evalFailed = null
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[eval] result ')) {
      try {
        payload = JSON.parse(trimmed.slice('[eval] result '.length))
      } catch {
        evalFailed = `无法解析 eval 输出：${trimmed.slice(0, 200)}`
      }
    } else if (trimmed.startsWith('[eval] failed ')) {
      evalFailed = trimmed.slice('[eval] failed '.length)
    }
  }
  return { payload, evalFailed }
}

/**
 * 逐行转发 Electron 输出（保留前缀便于排查）。
 * Chromium 在多个 Electron 并行时会刷缓存目录告警（disk_cache / gpu_disk_cache），
 * 与音频测试无关，这里计数后折叠，避免淹没断言输出。
 *
 * @param {string} stream
 * @param {string} text
 * @returns {void}
 */
function forwardOutput(stream, text) {
  let filtered = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    if (/disk_cache|cache_util_win|gpu_disk_cache/.test(trimmed)) {
      filtered += 1
      continue
    }
    console.log(`[electron:${stream}] ${trimmed}`)
  }
  if (filtered > 0) {
    console.log(`[electron:${stream}] （已折叠 ${filtered} 行 Chromium 缓存目录告警，与音频无关）`)
  }
}

/**
 * Node 侧合成 1 秒 WAV（供无 CORS 头的本地媒体服务器使用）。
 *
 * @returns {Buffer}
 */
function makeWavBuffer() {
  const sampleRate = 44100
  const sampleCount = sampleRate
  const buffer = Buffer.alloc(44 + sampleCount * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + sampleCount * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(sampleCount * 2, 40)
  for (let i = 0; i < sampleCount; i++) {
    const env = Math.min(1, i / 441, (sampleCount - i) / 441)
    const sample = (Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.6 + Math.sin((2 * Math.PI * 880 * i) / sampleRate) * 0.2) * env
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2)
  }
  return buffer
}

/**
 * 启动"不带任何 CORS 头"的本地媒体服务器（验证 crossOrigin 失败回退）。
 *
 * @returns {Promise<{ server: http.Server, port: number }>}
 */
function startCorslessMediaServer() {
  const wav = makeWavBuffer()
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/tone.wav')) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
        const start = range ? Number(range[1]) : 0
        const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1
        if (start > end || start >= wav.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${wav.length}` })
          res.end()
          return
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': 'audio/wav',
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
          ...(req.url.includes('case=context') ? { 'Access-Control-Allow-Origin': '*' } : {}),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
          'Cache-Control': 'no-store'
        })
        res.end(wav.subarray(start, end + 1))
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
      }
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/* ------------------------------------------------------------------------- *
 * 主流程
 * ------------------------------------------------------------------------- */

/**
 * 启动一个 Electron 实例执行 eval 文件，返回 stdout/stderr/退出码。
 * 环境统一清理：删除 ELECTRON_RUN_AS_NODE、设置 MP_DEV/MP_EVAL_FILE/MP_SHOT。
 *
 * @param {string} evalFile
 * @param {string} shotFile
 * @returns {Promise<{ exitCode: number | string, stdout: string, stderr: string }>}
 */
function runElectron(evalFile, shotFile) {
  return new Promise((resolve, reject) => {
    const electron = require('electron')
    if (typeof electron !== 'string') {
      reject(new Error('require("electron") 未返回二进制路径'))
      return
    }
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.MP_EVAL
    delete env.MP_SHOT_VIEW
    delete env.MP_SHOT_EXTRA
    delete env.MP_SHOT_W
    delete env.MP_SHOT_H
    env.MP_DEV = '1'
    env.MP_EVAL_FILE = evalFile
    env.MP_EVAL_WAIT = '4000'
    env.MP_SHOT = '1'
    env.MP_SHOT_OUT = shotFile
    env.MP_SHOT_WAIT = '100'

    const stdoutChunks = []
    const stderrChunks = []
    const child = spawn(electron, [ROOT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      killTree(child)
      resolve({
        exitCode: 'timeout',
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
    }, ELECTRON_TIMEOUT_MS)

    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * 默认场景断言。
 *
 * @param {{ payload: object | null, evalFailed: string | null, exitCode: number | string }} run
 * @returns {{ checks: object, pass: boolean }}
 */
function assertBase(run) {
  const payload = run.payload
  const currentTime = Number(payload && payload.currentTime)
  const hasAnalyser = Boolean(payload && payload.hasAnalyser)
  const fftMax = Number(payload && payload.fftMax)
  const checks = {
    electronExited: run.exitCode === 0,
    evalResult: Boolean(payload),
    evalFailed: run.evalFailed,
    evalThrown: payload && payload.thrown ? payload.thrown : null,
    loaded: Boolean(payload && payload.loaded),
    ready: Boolean(payload && payload.ready),
    playing: Boolean(payload && payload.playing),
    currentTimeGt02: Number.isFinite(currentTime) && currentTime > 0.2,
    durationGt05: Number(payload && payload.duration) > 0.5,
    analyserAvailable: hasAnalyser,
    fftNonZero: hasAnalyser ? fftMax > 0 : 'skipped (hasAnalyser=false)',
    degraded: (payload && payload.degraded) || null,
    error: (payload && payload.error) || null,
    waveformSpread: Number(payload && payload.waveformSpread) || 0,
    resolvedIsDataUrl: Boolean(payload && payload.resolvedIsDataUrl)
  }
  const pass =
    run.exitCode === 0 &&
    Boolean(payload) &&
    checks.currentTimeGt02 &&
    (hasAnalyser ? fftMax > 0 : true)
  return { checks, pass }
}

/**
 * `--extended` 场景断言（URL 解析 / 音量 / CORS 回退）。
 *
 * @param {{ payload: object | null, evalFailed: string | null, exitCode: number | string }} run
 * @returns {{ checks: object, pass: boolean }}
 */
function assertExtended(run) {
  const p = run.payload
  const resolve = (p && p.resolve) || {}
  const resolvePass =
    resolve.absoluteHttps === 'https://example.com/a.mp3' &&
    resolve.relativeWithoutBase === null &&
    resolve.relativeWithBase === 'http://127.0.0.1:8080/media/a.mp3' &&
    resolve.protocolRelative === 'http://127.0.0.1:8080/media/a.mp3' &&
    resolve.pendingDownload === null &&
    resolve.dataUrl === 'data-url'

  const volume = (p && p.volume) || {}
  const volumePass = volume.clampHigh === 1 && volume.clampLow === 0 && volume.restore === 1

  const mute = (p && p.mute) || {}
  const mutePass = mute.on === true && mute.off === false

  const pendingPass =
    p && p.pendingLoad === false && p.pendingTrack === null && p.pendingError === null

  const corsPass =
    Boolean(p) &&
    p.corsLoad === true &&
    p.corsFallbackFlag === true &&
    p.corsHasAnalyser === false &&
    p.corsDegraded === 'cors' &&
    p.corsErrorAfterLoad === null &&
    p.corsPlayOk === true &&
    p.corsReady === true &&
    p.corsPlaying === true &&
    Number(p.corsCurrentTime) > 0.2 &&
    p.corsError === null

  const immediateFallbackPass = p && p.immediateFallback && p.immediateFallback.fallback &&
    p.immediateFallback.playing && Number(p.immediateFallback.currentTime) > 0.1 && p.immediateFallback.error === null
  const contextFallbackPass = p && p.suspendedContextFallback && p.suspendedContextFallback.degraded === 'audio-context' &&
    p.suspendedContextFallback.playing && Number(p.suspendedContextFallback.currentTime) > 0.1
  const delayedContextPass = p && p.delayedContextFallback && p.delayedContextFallback.degraded === 'audio-context' &&
    p.delayedContextFallback.playing && Number(p.delayedContextFallback.currentTime) > 0.1

  const viz = (p && p.viz) || {}
  const vizPass =
    viz.bars === 32 &&
    viz.reducedMotion === true &&
    Number(viz.paintedPixels) > 0

  const checks = {
    electronExited: run.exitCode === 0,
    evalResult: Boolean(p),
    evalFailed: run.evalFailed,
    evalThrown: p && p.thrown ? p.thrown : null,
    resolvedUrlHandling: resolvePass,
    volumeClamp: volumePass,
    muteToggle: mutePass,
    pendingDownloadSilent: Boolean(pendingPass),
    corsFallback: Boolean(corsPass),
    immediateFallback: Boolean(immediateFallbackPass),
    immediateFallbackDetail: p && p.immediateFallback,
    contextFallback: Boolean(contextFallbackPass),
    contextFallbackDetail: p && p.suspendedContextFallback,
    delayedContextFallback: Boolean(delayedContextPass),
    visualizerStaticFrame: Boolean(vizPass),
    corsDetail: {
      load: p && p.corsLoad,
      fallback: p && p.corsFallbackFlag,
      hasAnalyser: p && p.corsHasAnalyser,
      degraded: p && p.corsDegraded,
      playOk: p && p.corsPlayOk,
      playing: p && p.corsPlaying,
      currentTime: p && p.corsCurrentTime,
      error: p && p.corsError
    },
    vizDetail: viz
  }
  const pass =
    run.exitCode === 0 &&
    Boolean(p) &&
    Boolean(resolvePass && volumePass && mutePass && pendingPass && corsPass && immediateFallbackPass && contextFallbackPass && delayedContextPass && vizPass)
  return { checks, pass }
}

async function main() {
  const startedAt = Date.now()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-audio-smoke-'))
  const evalFile = path.join(tempDir, 'audio-eval.js')
  const shotFile = path.join(tempDir, 'audio-smoke.png')
  let viteServer = null
  let mediaServer = null
  let mode = 'spawned-vite'

  try {
    /* 1. dev server：复用已有 / 自己起 / SKIP */
    if (await isPortOpen('127.0.0.1', PORT)) {
      if (await canReuseDevServer(PORT)) {
        mode = 'reused-dev-server'
        console.log(`[audio-smoke] 复用已有的 Vite dev server: http://localhost:${PORT}`)
      } else {
        const skip = { status: 'SKIP', port: PORT, reason: '端口被非本项目的进程占用，无法启动 dev server' }
        console.log(`[audio-smoke] ${JSON.stringify(skip)}`)
        return 0
      }
    } else {
      const { createServer } = await import('vite')
      viteServer = await createServer({
        root: ROOT,
        configFile: path.join(ROOT, 'vite.config.js'),
        logLevel: 'error',
        clearScreen: false,
        server: { host: 'localhost', port: PORT, strictPort: true }
      })
      try {
        await viteServer.listen()
      } catch (error) {
        if (error && String(error.code || error.message).includes('EADDRINUSE')) {
          const skip = { status: 'SKIP', port: PORT, reason: '端口在启动瞬间被占用' }
          console.log(`[audio-smoke] ${JSON.stringify(skip)}`)
          return 0
        }
        throw error
      }
      console.log(`[audio-smoke] 已启动 Vite dev server: http://localhost:${PORT}`)
    }

    if (!(await waitForHttp(PORT))) {
      console.log(`[audio-smoke] ${JSON.stringify({ status: 'FAIL', reason: 'dev server 未在 15s 内就绪' })}`)
      return 1
    }

    /* 2. 主场景：data URL 播放 + 频谱 */
    fs.writeFileSync(evalFile, BASE_EVAL_SCRIPT, 'utf8')
    const baseRun = await runElectron(evalFile, shotFile)
    forwardOutput('stdout', baseRun.stdout)
    forwardOutput('stderr', baseRun.stderr)
    const parsedBase = parseEvalOutput(baseRun.stdout)
    const base = assertBase({ ...parsedBase, exitCode: baseRun.exitCode })

    /* 3. 可选扩展场景：URL 解析 / 音量 / CORS 回退 */
    let extended = null
    if (EXTENDED) {
      const media = await startCorslessMediaServer()
      mediaServer = media.server
      const extendedEvalFile = path.join(tempDir, 'audio-eval-extended.js')
      fs.writeFileSync(
        extendedEvalFile,
        EXTENDED_EVAL_SCRIPT.replaceAll('__MEDIA_PORT__', String(media.port)),
        'utf8'
      )
      console.log(`[audio-smoke] 扩展场景：无 CORS 媒体服务器 http://127.0.0.1:${media.port}/tone.wav`)
      const extRun = await runElectron(extendedEvalFile, path.join(tempDir, 'audio-smoke-extended.png'))
      forwardOutput('stdout', extRun.stdout)
      forwardOutput('stderr', extRun.stderr)
      const parsedExt = parseEvalOutput(extRun.stdout)
      extended = assertExtended({ ...parsedExt, exitCode: extRun.exitCode })
    }

    const pass = base.pass && (!extended || extended.pass)
    const summary = {
      status: pass ? 'PASS' : 'FAIL',
      mode,
      port: PORT,
      checks: base.checks,
      payload: parsedBase.payload || null,
      electronExitCode: baseRun.exitCode,
      ...(extended
        ? { extended: { pass: extended.pass, checks: extended.checks } }
        : {}),
      durationMs: Date.now() - startedAt
    }
    console.log(`[audio-smoke] ${JSON.stringify(summary)}`)
    return pass ? 0 : 1
  } finally {
    if (mediaServer) {
      try {
        mediaServer.close()
      } catch {
        /* ignore */
      }
    }
    if (viteServer) {
      try {
        await viteServer.close()
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[audio-smoke] 未捕获异常:', error)
    console.log(`[audio-smoke] ${JSON.stringify({ status: 'FAIL', reason: String((error && error.message) || error) })}`)
    process.exit(1)
  })

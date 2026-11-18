/**
 * MusicParty 桌面端实时音频引擎。
 *
 * 职责：用 `HTMLAudioElement` 播放服务端下发的音源 URL，并尽力用 Web Audio
 * `AnalyserNode` 提供频谱/波形数据；不依赖任何 UI 组件、Pinia store 或歌单逻辑，
 * 只维护一个可被 Vue 直接绑定的 reactive 单例。
 *
 * 单位约定：
 * - 时间（`currentTime` / `duration` / `seek()` / `syncTo()`）统一为 **秒**；
 * - 音量（`setVolume()` / `engine.volume`）统一为 **0..1**；
 * - 频域/时域字节数据为 `Uint8Array`（频域 0..255，时域 128 为静音中心）。
 *
 * 降级策略：
 * - 音源支持 http(s) / file / data / blob 绝对地址，以及相对 `/media/...`（需 `baseUrl`）；
 * - `crossOrigin='anonymous'` 加载失败（服务端无 CORS）时自动重试为普通元素播放，
 *   放弃频谱但保证有声音，`engine.hasAnalyser === false`、`engine.degraded === 'cors'`；
 * - 环境没有 Web Audio / `AudioContext` 创建失败时同样只降级、不抛错。
 *
 * @module core/audio/engine
 */

import { reactive } from 'vue'

/** 与服务器进度偏差超过该值（秒）才强制 seek。 */
export const SEEK_DRIFT_TOLERANCE = 2.5

/** AnalyserNode 的 fftSize（频域 bin 数量为其一半）。 */
export const FFT_SIZE = 2048

/** 播放过程中 `currentTime` 的刷新间隔（毫秒）。 */
const TICK_INTERVAL = 250

/** 绝对地址 scheme。 */
const ABSOLUTE_SCHEME = /^(?:https?:|file:|data:|blob:)/i

/** 明确表示"暂不可播放"的占位 URL（协议里 B 站下载中的状态）。 */
const UNPLAYABLE_URL = /^(?:PENDING_DOWNLOAD|PENDING|DOWNLOADING)$/i

/** `HTMLMediaElement.error.code` → 中文提示。 */
const MEDIA_ERROR_TEXT = {
  1: '音频加载被中止',
  2: '网络错误，音频加载失败',
  3: '音频解码失败',
  4: '音源不可播放（格式不支持或服务端 CORS 受限）'
}

/**
 * 读取可选的全局媒体 base（`window.__MP_MEDIA_BASE__`），用于给相对 `/media/...` 兜底。
 * 每次动态读取，允许宿主在引擎加载后再注入。
 *
 * @returns {string}
 */
function readGlobalBaseUrl() {
  if (typeof window === 'undefined') return ''
  return typeof window.__MP_MEDIA_BASE__ === 'string' ? window.__MP_MEDIA_BASE__ : ''
}

/**
 * 全局唯一可响应状态。字段保持扁平，便于模板直接绑定。
 *
 * 基础字段为需求约定；`degraded` / `baseUrl` 为附加诊断字段：
 * - `degraded`：`hasAnalyser === false` 的原因（`'cors'` / `'disabled'` /
 *   `'unsupported'` / `'attach-failed'` / `'taint'`），正常时为 `null`；
 * - `baseUrl`：把相对 `/media/...` 拼成绝对地址的服务器 origin（可按需直接赋值）。
 */
export const engine = reactive({
  ready: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  error: null,
  hasAnalyser: false,
  track: null,
  degraded: null,
  baseUrl: readGlobalBaseUrl()
})

/* ------------------------------------------------------------------------- *
 * 模块内部状态
 * ------------------------------------------------------------------------- */

/** @type {HTMLAudioElement | null} */
let el = null
/** @type {AudioContext | null} */
let ctx = null
/** @type {AnalyserNode | null} */
let analyser = null
/** @type {MediaElementAudioSourceNode | null} */
let source = null
/** @type {Uint8Array | null} 频域复用缓冲（长度 = frequencyBinCount）。 */
let freqBuffer = null
/** @type {Uint8Array | null} 时域复用缓冲（长度 = fftSize）。 */
let timeBuffer = null
/** @type {ReturnType<typeof setInterval> | null} */
let ticker = null
/** 等 metadata 就绪后要应用的 seek 目标（秒）。 */
let pendingSeek = null
/** 本次加载是否要求分析器（`crossOrigin !== false`）。 */
let wantAnalyser = true
/** 是否已因 CORS 失败回退过（每次 setTrack 重置）。 */
let corsRetried = false
/** Desired transport state survives asynchronous CORS fallback / element replacement. */
let desiredPlaying = false
/** 当前元素上挂过的监听，销毁元素时统一移除。 */
let elementListeners = []

/* ------------------------------------------------------------------------- *
 * URL 解析
 * ------------------------------------------------------------------------- */

/**
 * 规范化 baseUrl：去掉尾部斜杠；非 http(s)/file 的输入直接丢弃。
 *
 * @param {unknown} value
 * @returns {string} 规范化后的 base（可能为空字符串）。
 */
function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  if (!/^(?:https?:|file:)/i.test(raw)) return ''
  return raw.replace(/\/+$/, '')
}

/**
 * 当前生效的 baseUrl：显式设置优先，其次 `window.__MP_MEDIA_BASE__`。
 *
 * @returns {string}
 */
export function getBaseUrl() {
  return normalizeBaseUrl(engine.baseUrl) || normalizeBaseUrl(readGlobalBaseUrl())
}

/**
 * 设置把相对 `/media/...` 拼成绝对地址的服务器 origin。
 * 例：`setBaseUrl('http://127.0.0.1:8080')` → `/media/a.mp3` 解析为
 * `http://127.0.0.1:8080/media/a.mp3`。
 *
 * @param {string} value 例如 `httpBase()` 的返回值。
 * @returns {string} 规范化后的 baseUrl。
 */
export function setBaseUrl(value) {
  engine.baseUrl = normalizeBaseUrl(value)
  return engine.baseUrl
}

/**
 * 把协议里的音源 URL 解析成 `<audio>` 可加载的绝对地址。
 *
 * 支持：
 * - `https://...` / `http://...` / `file://...` / `data:...` / `blob:...` 原样返回；
 * - `//host/path` 协议相对地址（需 baseUrl 提供协议）；
 * - `/media/<file>` 等相对地址 → 拼上 `baseUrl`；
 * - `PENDING_DOWNLOAD` / 空串 → 返回 `null`（不可播放，静默等待下一帧状态）。
 *
 * @param {unknown} rawUrl 服务端 `music.url`。
 * @param {string} [overrideBase] 本次解析使用的 baseUrl（默认用 {@link getBaseUrl}）。
 * @returns {string | null} 绝对 URL，或 `null`。
 */
export function resolveMediaUrl(rawUrl, overrideBase) {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!raw || UNPLAYABLE_URL.test(raw)) return null
  if (ABSOLUTE_SCHEME.test(raw)) return raw

  const base = normalizeBaseUrl(overrideBase) || getBaseUrl()
  if (!base) return null

  // 协议相对（`//host/path`）和普通相对路径都相对于配置的服务器 origin 解析
  try {
    return new URL(raw, `${base}/`).href
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------- *
 * 小工具
 * ------------------------------------------------------------------------- */

/**
 * 夹取到 [min, max]。
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 把任意输入归一化成合法的 bins 数量（1..256 的整数）。
 *
 * @param {unknown} count
 * @param {number} [fallback]
 * @returns {number}
 */
function normalizeCount(count, fallback = 64) {
  const n = Math.round(Number(count))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return clamp(n, 1, 256)
}

/**
 * 把秒数夹取到已知时长内（时长未知时只保证非负）。
 *
 * @param {number} seconds
 * @returns {number}
 */
function clampToDuration(seconds) {
  const duration = Number(engine.duration)
  const max = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY
  return clamp(Number(seconds) || 0, 0, max)
}

/* ------------------------------------------------------------------------- *
 * 元素与 Web Audio 图
 * ------------------------------------------------------------------------- */

/**
 * 移除当前 `<audio>` 元素上的监听并释放它。
 * 先断开 MediaElementAudioSourceNode，避免旧节点残留。
 *
 * @returns {void}
 */
function dropElement() {
  if (!el) return
  for (const [type, handler] of elementListeners) {
    el.removeEventListener(type, handler)
  }
  elementListeners = []
  try {
    el.pause()
  } catch {
    /* 元素可能已失效 */
  }
  if (source) {
    try {
      source.disconnect()
    } catch {
      /* 忽略重复断开 */
    }
    source = null
  }
  try {
    el.removeAttribute('src')
    el.load()
  } catch {
    /* 忽略失效元素 */
  }
  el = null
}

/**
 * 给元素绑定事件监听（统一登记，drop 时移除）。
 *
 * @param {HTMLAudioElement} audio
 * @param {string} type
 * @param {() => void} handler
 * @returns {void}
 */
function listen(audio, type, handler) {
  audio.addEventListener(type, handler)
  elementListeners.push([type, handler])
}

/**
 * 创建并配置一个新的 `<audio>` 元素（每次切歌都会重建，保证 CORS/taint 状态干净）。
 *
 * @returns {HTMLAudioElement | null}
 */
function createElement() {
  if (typeof Audio === 'undefined') {
    engine.error = '当前环境不支持音频播放'
    engine.degraded = 'unsupported'
    return null
  }
  const audio = new Audio()
  audio.preload = 'auto'
  audio.volume = clamp(Number(engine.volume) || 0, 0, 1)
  audio.muted = Boolean(engine.muted)

  listen(audio, 'loadedmetadata', handleLoadedMetadata)
  listen(audio, 'durationchange', syncDurationFromElement)
  listen(audio, 'canplay', handleCanPlay)
  listen(audio, 'play', handlePlay)
  listen(audio, 'playing', handlePlay)
  listen(audio, 'pause', handlePause)
  listen(audio, 'ended', handleEnded)
  listen(audio, 'timeupdate', syncCurrentTime)
  listen(audio, 'seeked', syncCurrentTime)
  listen(audio, 'volumechange', handleVolumeChange)
  listen(audio, 'error', handleMediaError)
  return audio
}

/**
 * 创建（或复用）AudioContext 与 AnalyserNode。
 *
 * @returns {AudioContext | null}
 */
function ensureAnalyserContext() {
  if (ctx && analyser) return ctx
  const Ctor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : typeof window !== 'undefined' && typeof window.webkitAudioContext !== 'undefined'
        ? window.webkitAudioContext
        : null
  if (!Ctor) {
    engine.degraded = 'unsupported'
    return null
  }
  try {
    ctx = new Ctor()
    analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0.8
    freqBuffer = new Uint8Array(analyser.frequencyBinCount)
    timeBuffer = new Uint8Array(analyser.fftSize)
    analyser.connect(ctx.destination)
    return ctx
  } catch {
    ctx = null
    analyser = null
    freqBuffer = null
    timeBuffer = null
    engine.degraded = 'unsupported'
    return null
  }
}

/**
 * 把当前元素接入 Web Audio 图（只在 CORS 加载成功后才调用，避免 taint 静音）。
 *
 * @returns {boolean} 是否已具备分析器。
 */
function attachAnalyser() {
  if (!wantAnalyser || corsRetried || !el) return false
  if (engine.hasAnalyser && source) return true
  const context = ensureAnalyserContext()
  if (!context || !analyser) return false
  try {
    source = context.createMediaElementSource(el)
    source.connect(analyser)
    engine.hasAnalyser = true
    return true
  } catch {
    source = null
    engine.hasAnalyser = false
    engine.degraded = 'attach-failed'
    return false
  }
}

/**
 * 播放前尽力恢复被浏览器自动播放策略挂起的 AudioContext。
 *
 * @returns {Promise<boolean>} whether the output context is running (or absent).
 */
async function resumeContext() {
  if (!ctx) return true
  if (ctx.state !== 'suspended') return ctx.state === 'running'
  try {
    await ctx.resume()
  } catch {
    return false
  }
  return ctx.state === 'running'
}

/* ------------------------------------------------------------------------- *
 * 事件处理
 * ------------------------------------------------------------------------- */

/** metadata 就绪：应用挂起的 seek，并记录时长。 @returns {void} */
function handleLoadedMetadata() {
  syncDurationFromElement()
  applyPendingSeek()
}

/** 可以播放：置 ready、接分析器、应用挂起 seek。 @returns {void} */
function handleCanPlay() {
  engine.ready = true
  if (attachAnalyser()) engine.degraded = corsRetried ? 'cors' : null
  // The AudioContext may be created after play() already tried to resume it.
  if (desiredPlaying && source) {
    const currentElement = el
    const currentTrack = engine.track
    void resumeContext().then(running => {
      // A suspended Web Audio graph silences the media element after it is attached.
      // Recreate the element without a graph rather than silently losing audio.
      if (!running && desiredPlaying && el === currentElement && engine.track === currentTrack) {
        retryWithoutCors('audio-context')
      }
    })
  }
  applyPendingSeek()
}

/** 开始播放。 @returns {void} */
function handlePlay() {
  engine.playing = true
  startTicker()
}

/** 暂停：同步一次真实进度。 @returns {void} */
function handlePause() {
  engine.playing = false
  stopTicker()
  syncCurrentTime()
}

/** 自然播放结束。 @returns {void} */
function handleEnded() {
  engine.playing = false
  stopTicker()
  syncCurrentTime()
  if (Number(engine.duration) > 0) engine.currentTime = Number(engine.duration)
}

/** 元素音量被外部修改时回写公共状态。 @returns {void} */
function handleVolumeChange() {
  if (!el) return
  engine.volume = clamp(Number(el.volume) || 0, 0, 1)
  engine.muted = Boolean(el.muted)
}

/** 元素加载/播放错误：优先尝试"无 CORS 回退"，再记录错误。 @returns {void} */
function handleMediaError() {
  if (!el) return
  const mediaError = el.error
  if (!mediaError) return // 切源时的 abort 不是致命错误
  // 带 crossOrigin 的加载失败（通常是服务端没有 ACAO 头）→ 退回元素直出，保留有声播放
  if (!corsRetried && wantAnalyser && el.crossOrigin && mediaError.code === 4) {
    retryWithoutCors()
    return
  }
  engine.ready = false
  engine.playing = false
  stopTicker()
  engine.error = MEDIA_ERROR_TEXT[mediaError.code] || '音频加载失败'
}

/** 应用挂起的 seek（metadata 就绪后）。 @returns {void} */
function applyPendingSeek() {
  if (pendingSeek == null || !el) return
  if (el.readyState < 1) return
  const target = pendingSeek
  pendingSeek = null
  try {
    el.currentTime = clampToDuration(target)
    engine.currentTime = clampToDuration(target)
  } catch {
    pendingSeek = target
  }
}

/** 从元素回读真实时长（有限值时以元素为准）。 @returns {void} */
function syncDurationFromElement() {
  if (!el) return
  const duration = Number(el.duration)
  if (Number.isFinite(duration) && duration > 0) {
    engine.duration = duration
  } else if (engine.track && Number(engine.track.duration) > 0) {
    engine.duration = Number(engine.track.duration)
  }
}

/** 从元素回读真实进度。 @returns {void} */
function syncCurrentTime() {
  if (!el) return
  const time = Number(el.currentTime)
  if (Number.isFinite(time)) engine.currentTime = Math.max(0, time)
  syncDurationFromElement()
}

/** 开始播放时启动 currentTime 轮询（元素 timeupdate 在部分场景太稀疏）。 @returns {void} */
function startTicker() {
  if (ticker) return
  ticker = setInterval(syncCurrentTime, TICK_INTERVAL)
}

/** 停止 currentTime 轮询。 @returns {void} */
function stopTicker() {
  if (!ticker) return
  clearInterval(ticker)
  ticker = null
}

/**
 * CORS 加载失败后的优雅降级：重建不带 crossOrigin 的元素，音源不变，
 * 放弃频谱（`hasAnalyser = false`），尽量保持"有声音、不抛错"。
 *
 * @returns {void}
 */
function retryWithoutCors(reason = 'cors') {
  const track = engine.track
  const src = track && track.resolvedUrl ? track.resolvedUrl : null
  if (!src) return
  const resumeAt = clampToDuration(pendingSeek != null ? pendingSeek : engine.currentTime)
  const shouldResume = desiredPlaying

  corsRetried = true
  wantAnalyser = false
  engine.hasAnalyser = false
  engine.degraded = reason
  engine.error = null
  engine.ready = false
  stopTicker()
  dropElement()

  el = createElement()
  if (!el) return
  track.corsFallback = reason === 'cors'
  pendingSeek = resumeAt > 0 ? resumeAt : null
  try {
    el.src = src
    el.load()
  } catch {
    engine.error = '音频加载失败'
    return
  }
  if (shouldResume) void play()
}

/* ------------------------------------------------------------------------- *
 * 公共 API：播放控制
 * ------------------------------------------------------------------------- */

/**
 * 装载一首新音源（不自动播放；播放态由 {@link play} / {@link syncTo} 决定）。
 *
 * @param {Object | string} input 音源信息；也接受纯 URL 字符串。
 * @param {string} input.url 原始音源 URL（http/https/file/data/blob/相对 `/media/...`）。
 * @param {number} [input.duration] 已知时长（秒），元素 metadata 就绪后会被真实值覆盖。
 * @param {number} [input.startAt=0] 初始进度（秒），metadata 就绪后自动 seek。
 * @param {string} [input.baseUrl] 本次使用的服务器 origin（会写入 `engine.baseUrl`）。
 * @param {boolean} [input.crossOrigin=true] 是否尝试 CORS + 频谱；false 时只做元素直出。
 * @returns {boolean} 是否成功装载了一个可播放音源。
 */
export function setTrack(input) {
  const opts = typeof input === 'string' ? { url: input } : input || {}
  const rawUrl = typeof opts.url === 'string' ? opts.url.trim() : ''
  desiredPlaying = false

  // 任何一次装载都先清掉旧音源（新元素 → 干净的 CORS 状态）
  stopTicker()
  dropElement()
  corsRetried = false
  pendingSeek = null
  wantAnalyser = opts.crossOrigin !== false
  engine.ready = false
  engine.playing = false
  engine.currentTime = 0
  engine.duration = 0
  engine.error = null
  engine.hasAnalyser = false
  engine.degraded = wantAnalyser ? null : 'disabled'
  engine.track = null

  if (opts.baseUrl) engine.baseUrl = normalizeBaseUrl(opts.baseUrl)

  if (!rawUrl || UNPLAYABLE_URL.test(rawUrl)) {
    // 协议约定：PENDING_DOWNLOAD / 空 URL 视为不可播放，等下一帧状态，不报错
    return false
  }

  const resolvedUrl = resolveMediaUrl(rawUrl)
  if (!resolvedUrl) {
    engine.error = /^\//.test(rawUrl) || rawUrl.startsWith('//')
      ? '相对音源地址需要 baseUrl（例如 setBaseUrl(httpBase())）'
      : `无法解析音源地址：${rawUrl}`
    return false
  }

  el = createElement()
  if (!el) return false

  const duration = Number(opts.duration)
  const startAt = Math.max(0, Number(opts.startAt) || 0)
  engine.track = {
    url: rawUrl,
    resolvedUrl,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    startAt,
    crossOrigin: wantAnalyser,
    corsFallback: false
  }
  engine.duration = engine.track.duration
  engine.currentTime = startAt
  pendingSeek = startAt > 0 ? startAt : null

  try {
    el.crossOrigin = wantAnalyser ? 'anonymous' : null
    el.src = resolvedUrl
    el.load()
  } catch {
    engine.error = '音频加载失败'
    return false
  }
  return true
}

/**
 * 播放当前音源。自动播放被拦截时记录 `engine.error = '需要用户交互'`，
 * 之后在用户手势中再次调用即可（不做永久锁定）。
 *
 * @returns {Promise<boolean>} 是否真正开始播放。
 */
export async function play() {
  if (!el || !engine.track) return false
  desiredPlaying = true
  const playingElement = el
  const playingTrack = engine.track
  const contextRunning = await resumeContext()
  if (el !== playingElement || engine.track !== playingTrack || !desiredPlaying) return false
  if (!contextRunning && source) {
    retryWithoutCors('audio-context')
    return false
  }
  try {
    await playingElement.play()
    if (el !== playingElement || engine.track !== playingTrack) return false
    await resumeContext()
    engine.error = null
    return true
  } catch (error) {
    // A replaced element can reject its old play promise after the new one succeeds.
    if (el !== playingElement || engine.track !== playingTrack || !desiredPlaying) return false
    const name = error && error.name
    if (name === 'NotAllowedError') {
      desiredPlaying = false
      engine.error = '需要用户交互'
    } else if (name === 'AbortError') {
      // 加载被新的 setTrack/seek 打断：不算错误
      desiredPlaying = false
      return false
    } else {
      desiredPlaying = false
      engine.error = `播放失败：${(error && error.message) || String(error)}`
    }
    return false
  }
}

/**
 * 暂停当前音源。
 *
 * @returns {boolean} 是否有可暂停的元素。
 */
export function pause() {
  desiredPlaying = false
  if (!el) return false
  try {
    el.pause()
  } catch {
    return false
  }
  engine.playing = false
  return true
}

/**
 * 播放/暂停切换。
 *
 * @returns {Promise<boolean>} 切换后是否处于播放态。
 */
export async function toggle() {
  if (!el) return false
  if (el.paused) {
    await play()
  } else {
    pause()
  }
  return !el.paused
}

/**
 * seek 到指定秒数（夹取到 [0, duration]）。metadata 未就绪时先挂起，就绪后应用。
 *
 * @param {number} seconds 目标秒数。
 * @returns {boolean} 是否立即应用到了元素上（false 表示已挂起或不可用）。
 */
export function seek(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return false
  const target = clampToDuration(Math.max(0, value))
  engine.currentTime = target
  if (!el) return false
  if (el.readyState >= 1) {
    try {
      el.currentTime = target
      return true
    } catch {
      pendingSeek = target
      return false
    }
  }
  pendingSeek = target
  return false
}

/**
 * 与服务端权威进度对齐：漂移超过 {@link SEEK_DRIFT_TOLERANCE} 秒才 seek，
 * 播放态不一致才 play/pause（避免频繁抖动）。
 *
 * @param {number} serverProgress 服务端进度（秒）。
 * @param {boolean} serverPlaying 服务端是否处于播放态。
 * @returns {{ action: 'none'|'seek'|'play'|'pause'|'no-track', seeked: boolean, played: boolean, paused: boolean, drift: number | null }}
 */
export function syncTo(serverProgress, serverPlaying) {
  const result = { action: 'none', seeked: false, played: false, paused: false, drift: null }
  if (!el || !engine.track) {
    result.action = 'no-track'
    return result
  }

  const progress = Number(serverProgress)
  const shouldPlay = Boolean(serverPlaying)

  if (Number.isFinite(progress) && progress >= 0 && (!shouldPlay || (el.readyState >= 3 && !el.seeking))) {
    const current = Number(el.currentTime) || Number(engine.currentTime) || 0
    const drift = current - progress
    result.drift = Math.round(drift * 1000) / 1000
    // 与网页版一样，后台窗口容许更大的误差，避免托盘播放时频繁 seek。
    const tolerance = shouldPlay && typeof document !== 'undefined' && document.hidden ? 10 : SEEK_DRIFT_TOLERANCE
    if (Math.abs(drift) > tolerance) {
      seek(progress)
      result.seeked = true
      result.action = 'seek'
    }
  }

  if (shouldPlay && el.paused && !desiredPlaying) {
    play().catch(() => {
      /* 错误已写入 engine.error */
    })
    result.played = true
    result.action = 'play'
  } else if (!shouldPlay && (desiredPlaying || !el.paused)) {
    pause()
    result.paused = true
    result.action = 'pause'
  }

  return result
}

/**
 * 设置音量（0..1，自动夹取）。
 *
 * @param {number} value 0..1。
 * @returns {number} 实际生效音量。
 */
export function setVolume(value) {
  const volume = clamp(Number(value), 0, 1)
  const next = Number.isFinite(volume) ? volume : 0
  engine.volume = next
  if (el) {
    try {
      el.volume = next
    } catch {
      /* 元素失效时只更新状态 */
    }
  }
  return next
}

/**
 * 静音开关。不传参时切换；传参时设置。
 *
 * @param {boolean} [flag]
 * @returns {boolean} 设置后的静音状态。
 */
export function mute(flag) {
  const next = flag === undefined ? !engine.muted : Boolean(flag)
  engine.muted = next
  if (el) {
    try {
      el.muted = next
    } catch {
      /* 元素失效时只更新状态 */
    }
  }
  return next
}

/* ------------------------------------------------------------------------- *
 * 公共 API：频谱数据
 * ------------------------------------------------------------------------- */

/**
 * 读取频域数据（Uint8Array，0..255，按最大值降采样到 `count` 个 bin）。
 * 分析器不可用（CORS 回退 / 无 Web Audio / 未播放）时返回全 0 数组，
 * 并通过 `engine.hasAnalyser === false` 标记降级。
 *
 * @param {number} [count=64] 需要的 bin 数量（1..256）。
 * @returns {Uint8Array} 长度恰为 `count`；每次调用返回新数组，可安全持有。
 */
export function getFrequencyBins(count = 64) {
  const size = normalizeCount(count)
  const out = new Uint8Array(size)
  if (!analyser || !engine.hasAnalyser || !freqBuffer) return out
  try {
    analyser.getByteFrequencyData(freqBuffer)
  } catch {
    engine.hasAnalyser = false
    engine.degraded = 'taint'
    return out
  }

  const length = freqBuffer.length
  if (size === length) {
    out.set(freqBuffer)
    return out
  }
  const bucket = length / size
  for (let i = 0; i < size; i++) {
    const start = Math.floor(i * bucket)
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket))
    let max = 0
    for (let j = start; j < end && j < length; j++) {
      if (freqBuffer[j] > max) max = freqBuffer[j]
    }
    out[i] = max
  }
  return out
}

/**
 * 读取时域波形（Uint8Array，0..255，128 为静音中心）。
 * 分析器不可用时返回中心值 128 组成的直线（避免误显示为削波）。
 *
 * @param {number} [count=64] 需要的采样点数量（1..256）。
 * @returns {Uint8Array} 长度恰为 `count`。
 */
export function getWaveform(count = 64) {
  const size = normalizeCount(count)
  const out = new Uint8Array(size)
  if (!analyser || !engine.hasAnalyser || !timeBuffer) {
    out.fill(128)
    return out
  }
  try {
    analyser.getByteTimeDomainData(timeBuffer)
  } catch {
    engine.hasAnalyser = false
    engine.degraded = 'taint'
    out.fill(128)
    return out
  }
  const length = timeBuffer.length
  for (let i = 0; i < size; i++) {
    const index = Math.min(length - 1, Math.floor((i * length) / size))
    out[i] = timeBuffer[index]
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * 生命周期
 * ------------------------------------------------------------------------- */

/**
 * 销毁引擎：停止轮询、断开 Web Audio 图、关闭 AudioContext 并复位公共状态。
 * 之后仍可重新调用 {@link setTrack} 复用单例。
 *
 * @returns {void}
 */
export function destroy() {
  desiredPlaying = false
  stopTicker()
  dropElement()
  if (ctx) {
    try {
      ctx.close()
    } catch {
      /* 已关闭 */
    }
    ctx = null
  }
  analyser = null
  freqBuffer = null
  timeBuffer = null
  pendingSeek = null
  corsRetried = false
  wantAnalyser = true

  engine.ready = false
  engine.playing = false
  engine.currentTime = 0
  engine.duration = 0
  engine.volume = 1
  engine.muted = false
  engine.error = null
  engine.hasAnalyser = false
  engine.track = null
  engine.degraded = null
  engine.baseUrl = readGlobalBaseUrl()
}

/* 同时以 `engine.setTrack(...)` 形式暴露方法，便于 UI 层直接拿单例调用。 */
Object.assign(engine, {
  setTrack,
  play,
  pause,
  toggle,
  seek,
  setVolume,
  mute,
  syncTo,
  getFrequencyBins,
  getWaveform,
  setBaseUrl,
  getBaseUrl,
  resolveMediaUrl,
  destroy
})

export default engine

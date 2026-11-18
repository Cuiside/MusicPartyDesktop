/**
 * MusicParty 桌面端托盘桥（渲染层 ESM）。
 *
 * 数据源是 preload 暴露的 `window.mpDesktop.tray`：
 *   setState(patch) / getState() / onState(cb) / onCommand(cb)
 *   / sendCommand(type) / showMain() / hideCard() / quitApp()
 *
 * 两个窗口共用这一个模块：
 *  - 主窗口（App.vue）：用 `pushTrayState(patch)` 推送当前歌曲/点赞/本机静音；
 *    用 `onTrayCommand(cb)` 接收托盘发来的 `{type:'like'}` / `{type:'local-mute'}`。
 *  - 托盘小窗口（`?tray=1`，TrayCard.vue）：模块加载时自动订阅 `onState` 并维护
 *    reactive `tray`；`requestTrayState()` 拉取主进程缓存。
 *
 * 非 Electron / 无 preload 环境下所有方法降级为 no-op（返回 false / 空 unsubscribe），
 * 组件仍可渲染默认的空状态，不会报错。
 */

import { reactive } from 'vue'

const STRING_LIMITS = { title: 160, artist: 80, coverUrl: 2048 }

function emptyState() {
  return {
    available: false,
    ready: false,
    title: '',
    artist: '',
    coverUrl: '',
    liked: false,
    muted: false,
    playing: false
  }
}

function getApi() {
  if (typeof window === 'undefined') return null
  const desktop = window.mpDesktop
  const api = desktop && desktop.tray
  return api && typeof api === 'object' ? api : null
}

/** reactive 托盘状态（TrayCard 直接使用；主窗口也可读） */
export const tray = reactive({ ...emptyState(), available: Boolean(getApi()) })

function clampText(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > limit ? text.slice(0, limit) : text
}

/** 只保留契约字段并做类型归一化；未知字段忽略。 */
export function sanitizeTrayState(patch) {
  const out = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const key of ['title', 'artist', 'coverUrl']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = clampText(patch[key], STRING_LIMITS[key])
    }
  }
  for (const key of ['liked', 'muted', 'playing']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = Boolean(patch[key])
    }
  }
  return out
}

/** 把 patch 合并进 reactive 状态；返回是否发生了变化。 */
function applyTrayState(patch) {
  const clean = sanitizeTrayState(patch)
  let changed = false
  for (const [key, value] of Object.entries(clean)) {
    if (tray[key] !== value) {
      tray[key] = value
      changed = true
    }
  }
  return changed
}

/**
 * 主窗口 → 主进程：推送当前播放/点赞/本机静音状态。
 * @param {{title?:string, artist?:string, coverUrl?:string, liked?:boolean, muted?:boolean, playing?:boolean}} patch
 * @returns {boolean} 是否成功发送（无 preload 时 false）
 */
export function pushTrayState(patch) {
  applyTrayState(patch)
  const api = getApi()
  if (!api || typeof api.setState !== 'function') return false
  const clean = sanitizeTrayState(patch)
  if (Object.keys(clean).length === 0) return false
  try {
    api.setState(clean)
    return true
  } catch {
    return false
  }
}

/** 兼容命名：setTrayState 与 pushTrayState 等价。 */
export const setTrayState = pushTrayState

/**
 * 主窗口 ← 主进程：订阅托盘发来的命令。
 * @param {(command: {type: string}) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onTrayCommand(callback) {
  if (typeof callback !== 'function') return () => {}
  const api = getApi()
  if (!api || typeof api.onCommand !== 'function') return () => {}
  try {
    const off = api.onCommand((command) => {
      if (!command || typeof command !== 'object' || typeof command.type !== 'string') return
      callback({ ...command, type: command.type })
    })
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

/**
 * 托盘窗口 ← 主进程：订阅状态变化（模块加载时自动订阅，通常无需手动调用）。
 * @param {(state: object) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onTrayState(callback) {
  if (typeof callback !== 'function') return () => {}
  const api = getApi()
  if (!api || typeof api.onState !== 'function') return () => {}
  try {
    const off = api.onState((state) => {
      if (!state || typeof state !== 'object') return
      applyTrayState(state)
      tray.ready = true
      callback(tray)
    })
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

/**
 * 托盘窗口：主动向主进程要一次缓存状态（窗口显示时调用）。
 * @returns {Promise<typeof tray>}
 */
export async function requestTrayState() {
  const api = getApi()
  if (!api || typeof api.getState !== 'function') {
    tray.ready = true
    return tray
  }
  try {
    const state = await api.getState()
    applyTrayState(state)
  } catch {
    /* 主进程未实现 / 窗口正在销毁：保持默认空状态 */
  }
  tray.ready = true
  return tray
}

/** 托盘窗口：把用户命令发给主进程（主进程再转发给主窗口执行）。 */
export function sendTrayCommand(type, payload) {
  const command = typeof type === 'string' ? type.trim() : ''
  if (!command) return false
  const api = getApi()
  if (!api || typeof api.sendCommand !== 'function') return false
  try {
    api.sendCommand(command, payload && typeof payload === 'object' ? payload : undefined)
    return true
  } catch {
    return false
  }
}

/** 显示主窗口（隐藏托盘卡）。 */
export function showMain() {
  const api = getApi()
  if (!api || typeof api.showMain !== 'function') return false
  try {
    api.showMain()
    return true
  } catch {
    return false
  }
}

/** 隐藏托盘卡片窗口。 */
export function hideCard() {
  const api = getApi()
  if (!api || typeof api.hideCard !== 'function') return false
  try {
    api.hideCard()
    return true
  } catch {
    return false
  }
}

/** 退出整个应用。 */
export function quitApp() {
  const api = getApi()
  if (!api || typeof api.quitApp !== 'function') return false
  try {
    api.quitApp()
    return true
  } catch {
    return false
  }
}

/** 当前是否跑在托盘小窗口（`?tray=1`）。 */
export function isTrayWindow() {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('tray') === '1'
  } catch {
    return false
  }
}

/* 模块加载即订阅主进程状态广播（仅托盘窗口会收到 `mp:tray:state` 事件）。 */
try {
  const api = getApi()
  if (api && typeof api.onState === 'function') {
    api.onState((state) => {
      if (state && typeof state === 'object') {
        applyTrayState(state)
        tray.ready = true
      }
    })
  }
} catch {
  /* ignore */
}

export default tray

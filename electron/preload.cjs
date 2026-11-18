'use strict'

/**
 * MusicParty preload：把主进程能力以 `window.mpDesktop` 暴露给渲染层。
 *
 * 命名空间：
 *  - window.*   窗口控制 + 关闭询问（requestClose / respondClose / onCloseRequest）
 *  - app.*      app 信息
 *  - launcher.* 本地服务启动器（见 docs/LAUNCHER.md）
 *  - tray.*     系统托盘状态/命令（见 docs/LOCAL_AUDIO_TRAY.md）
 *  - http.*     免 CORS 的 HTTP 桥
 *
 * 关闭询问的兜底弹窗：主进程发送 `mp:window:close-request` 后，
 *  - 若渲染层（App.vue）订阅了 `onCloseRequest`，完全交给渲染层弹窗；
 *  - 否则由本 preload 注入一个与设计系统一致的三选一弹窗（关闭应用 / 隐藏到托盘 / 取消），
 *    保证在渲染层尚未接入时功能也完整可用。
 */

const { contextBridge, ipcRenderer } = require('electron')

/* ------------------------------------------------------------------ */
/* 通用订阅工具                                                        */
/* ------------------------------------------------------------------ */

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => {
    try {
      callback(payload)
    } catch (error) {
      // 渲染层回调异常不应打断 IPC 事件循环
      console.error(`[preload] ${channel} listener failed`, error)
    }
  }
  ipcRenderer.on(channel, listener)
  return () => {
    try {
      ipcRenderer.removeListener(channel, listener)
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 关闭询问（close request / response）                                */
/* ------------------------------------------------------------------ */

/** @type {Set<(payload: {id: number | null, canTray: boolean, preview: boolean}) => void>} */
const closeRequestSubscribers = new Set()
let lastCloseRequestId = null

function normalizeCloseRequest(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}
  return {
    id: typeof source.id === 'number' ? source.id : null,
    canTray: source.canTray !== false,
    preview: source.preview === true
  }
}

function handleCloseRequest(payload) {
  const request = normalizeCloseRequest(payload)
  if (request.id != null) lastCloseRequestId = request.id
  if (closeRequestSubscribers.size > 0) {
    for (const subscriber of closeRequestSubscribers) {
      try {
        subscriber({ ...request })
      } catch (error) {
        console.error('[preload] onCloseRequest subscriber failed', error)
      }
    }
    return
  }
  showFallbackClosePrompt(request)
}

function respondClose(action, remember = false) {
  const normalized = action === 'close' || action === 'tray' || action === 'cancel' ? action : 'cancel'
  removeFallbackClosePrompt()
  ipcRenderer.send('mp:window:close-response', { action: normalized, id: lastCloseRequestId, remember: remember === true })
}

/**
 * 渲染层订阅关闭询问。订阅者存在时 preload 不再注入兜底弹窗；
 * 渲染层必须在用户选择后调用 `respondClose()`。
 */
function onCloseRequest(callback) {
  if (typeof callback !== 'function') return () => {}
  closeRequestSubscribers.add(callback)
  removeFallbackClosePrompt()
  return () => {
    closeRequestSubscribers.delete(callback)
  }
}

/* ---------- 兜底三选一弹窗（原生 DOM 注入，样式对齐设计系统） ---------- */

const PROMPT_ATTR = 'data-mp-close-prompt'
const PROMPT_STYLE_ID = 'mp-close-prompt-style'
const PROMPT_Z_INDEX = 2147483000

let fallbackPromptEl = null
let fallbackPromptCleanup = null

const PROMPT_CSS = `
.mp-close-overlay{position:fixed;inset:0;z-index:${PROMPT_Z_INDEX};display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(20,20,20,.46);font-family:'Space Grotesk','Microsoft YaHei UI','Microsoft YaHei','PingFang SC',system-ui,sans-serif;color:#141414}
.mp-close-panel{width:min(420px,100%);background:#fcfcfd;border:1px solid #141414;box-shadow:10px 10px 0 rgba(20,20,20,.22);display:flex;flex-direction:column;box-sizing:border-box}
.mp-close-top{display:flex;align-items:center;gap:10px;height:44px;padding:0 16px;background:#ffcd38;border-bottom:1px solid #e0ae00;box-sizing:border-box}
.mp-close-mark{display:grid;place-items:center;width:24px;height:24px;background:#141414;color:#fcfcfd;font-size:10px;font-weight:700;letter-spacing:.02em;flex:none}
.mp-close-eyebrow{font-size:10px;font-weight:700;letter-spacing:.16em;color:rgba(20,20,20,.62)}
.mp-close-title{margin:18px 18px 6px;font-size:19px;font-weight:700;line-height:1.25;letter-spacing:-.01em}
.mp-close-text{margin:0 18px 16px;font-size:12.5px;line-height:1.65;color:rgba(20,20,20,.66)}
.mp-close-actions{display:flex;flex-direction:column;gap:8px;padding:0 18px 16px}
.mp-close-btn{height:38px;padding:0 12px;border:1px solid #141414;background:#fcfcfd;color:#141414;font-family:inherit;font-size:13px;font-weight:600;letter-spacing:.02em;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.mp-close-btn:hover{background:#f6f4ee}
.mp-close-btn:focus-visible{outline:2px solid #141414;outline-offset:2px}
.mp-close-btn.primary{background:#141414;color:#fcfcfd}
.mp-close-btn.primary:hover{background:#2a2a2a}
.mp-close-btn.ghost{border-color:transparent;background:transparent;color:rgba(20,20,20,.72);font-weight:500}
.mp-close-btn.ghost:hover{background:rgba(20,20,20,.06)}
.mp-close-foot{display:flex;align-items:center;justify-content:space-between;height:26px;padding:0 18px;border-top:1px solid #e0ae00;background:#ffcd38;font-size:9px;font-weight:600;letter-spacing:.12em;color:rgba(20,20,20,.62)}
`

function injectClosePromptStyles() {
  if (document.getElementById(PROMPT_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = PROMPT_STYLE_ID
  style.textContent = PROMPT_CSS
  document.head.appendChild(style)
}

function removeFallbackClosePrompt() {
  if (fallbackPromptCleanup) {
    try {
      fallbackPromptCleanup()
    } catch {
      /* ignore */
    }
    fallbackPromptCleanup = null
  }
  if (fallbackPromptEl && fallbackPromptEl.parentNode) {
    fallbackPromptEl.parentNode.removeChild(fallbackPromptEl)
  }
  fallbackPromptEl = null
}

function createButton(label, className, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `mp-close-btn${className ? ` ${className}` : ''}`
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function showFallbackClosePrompt(request) {
  if (typeof document === 'undefined' || !document.body) return
  if (fallbackPromptEl) return
  injectClosePromptStyles()

  const overlay = document.createElement('div')
  overlay.className = 'mp-close-overlay'
  overlay.setAttribute(PROMPT_ATTR, '')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'mp-close-title')

  const panel = document.createElement('div')
  panel.className = 'mp-close-panel'

  const top = document.createElement('div')
  top.className = 'mp-close-top'
  const mark = document.createElement('span')
  mark.className = 'mp-close-mark'
  mark.textContent = 'MP'
  const eyebrow = document.createElement('span')
  eyebrow.className = 'mp-close-eyebrow'
  eyebrow.textContent = 'MUSIC PARTY · 关闭窗口'
  top.appendChild(mark)
  top.appendChild(eyebrow)

  const title = document.createElement('h2')
  title.className = 'mp-close-title'
  title.id = 'mp-close-title'
  title.textContent = '关闭 MUSIC PARTY？'

  const text = document.createElement('p')
  text.className = 'mp-close-text'
  text.textContent = request.canTray
    ? '隐藏到托盘后，房间连接与本地播放会继续运行；你可以随时从托盘重新打开主界面。'
    : '当前环境无法使用系统托盘，关闭应用会结束本地播放。'

  const actions = document.createElement('div')
  actions.className = 'mp-close-actions'

  let primaryAction = 'close'
  let primaryButton
  if (request.canTray) {
    primaryAction = 'tray'
    primaryButton = createButton('隐藏到托盘', 'primary', () => respondClose('tray'))
    actions.appendChild(primaryButton)
    actions.appendChild(createButton('关闭应用', '', () => respondClose('close')))
  } else {
    primaryButton = createButton('关闭应用', 'primary', () => respondClose('close'))
    actions.appendChild(primaryButton)
  }
  actions.appendChild(createButton('取消', 'ghost', () => respondClose('cancel')))

  const foot = document.createElement('div')
  foot.className = 'mp-close-foot'
  const hint = document.createElement('span')
  hint.textContent = 'ESC 取消'
  const hint2 = document.createElement('span')
  hint2.textContent = 'ENTER 确认'
  foot.appendChild(hint)
  foot.appendChild(hint2)

  panel.appendChild(top)
  panel.appendChild(title)
  panel.appendChild(text)
  panel.appendChild(actions)
  panel.appendChild(foot)
  overlay.appendChild(panel)

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      respondClose('cancel')
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      respondClose(primaryAction)
    }
  }
  const onOverlayClick = (event) => {
    if (event.target === overlay) respondClose('cancel')
  }

  overlay.addEventListener('click', onOverlayClick)
  document.addEventListener('keydown', onKeyDown, true)
  document.body.appendChild(overlay)

  fallbackPromptEl = overlay
  fallbackPromptCleanup = () => document.removeEventListener('keydown', onKeyDown, true)
  try {
    primaryButton.focus()
  } catch {
    /* ignore */
  }
}

ipcRenderer.on('mp:window:close-request', (_event, payload) => handleCloseRequest(payload))

/* ------------------------------------------------------------------ */
/* 暴露给渲染层的 window.mpDesktop                                     */
/* ------------------------------------------------------------------ */

contextBridge.exposeInMainWorld('mpDesktop', {
  window: {
    minimize: () => ipcRenderer.send('mp:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('mp:window', 'maximize'),
    close: () => ipcRenderer.send('mp:window', 'close'),
    isMaximized: () => ipcRenderer.invoke('mp:window:isMaximized'),
    /** 主动发起一次关闭询问（等价点击标题栏 X）。 */
    requestClose: () => ipcRenderer.send('mp:window:request-close'),
    /** 回答关闭询问：'close'（退出应用）/ 'tray'（隐藏到托盘）/ 'cancel'（取消）。 */
    respondClose: (action, remember) => respondClose(action, remember),
    getClosePreference: () => ipcRenderer.invoke('mp:window:close-preference:get'),
    setClosePreference: (action) => ipcRenderer.invoke('mp:window:close-preference:set', action),
    /** 订阅关闭询问；订阅后由渲染层负责弹窗。返回 unsubscribe。 */
    onCloseRequest: (callback) => onCloseRequest(callback)
  },
  app: {
    info: () => ipcRenderer.invoke('mp:app:info'),
    notifyChat: (data) => ipcRenderer.send('mp:chat:notify', data),
    acknowledgeInstantChat: (sequence) => ipcRenderer.send('mp:chat:instant-ack', sequence),
    onOpenInstantChat: (callback) => {
      const unsubscribe = subscribe('mp:chat:open-instant', callback)
      ipcRenderer.send('mp:chat:instant-ready')
      return unsubscribe
    }
  },
  launcher: {
    getConfig: () => ipcRenderer.invoke('launcher:config:get'),
    setConfig: (patch) => ipcRenderer.invoke('launcher:config:set', patch),
    start: () => ipcRenderer.invoke('launcher:start'),
    stop: () => ipcRenderer.invoke('launcher:stop'),
    restart: () => ipcRenderer.invoke('launcher:restart'),
    status: () => ipcRenderer.invoke('launcher:status'),
    openDataDir: () => ipcRenderer.invoke('launcher:openDataDir'),
    clearLocalData: () => ipcRenderer.invoke('launcher:data:clear'),
    pickFile: (kind) => ipcRenderer.invoke('launcher:pickFile', { kind }),
    /** 秘密存储（D-03）：getConfig 只返回 *Set 布尔；这些接口按需读写，永不回显旧值。 */
    setSecrets: (patch) => ipcRenderer.invoke('launcher:secrets:set', patch || {}),
    clearSecrets: (options) => ipcRenderer.invoke('launcher:secrets:clear', options || {}),
    ensureLocalAdminPassword: () => ipcRenderer.invoke('launcher:secrets:ensureAdminPassword'),
    revealLocalAdminPassword: () => ipcRenderer.invoke('launcher:secrets:revealAdminPassword'),
    onLog: (callback) => subscribe('launcher:log', callback),
    onStatus: (callback) => subscribe('launcher:status', callback)
  },
  tray: {
    /** 主窗口 → 主进程：推送 { title, artist, coverUrl, liked, muted, playing }。 */
    setState: (patch) => ipcRenderer.send('mp:tray:set-state', patch),
    /** 托盘窗口：读取主进程缓存的状态。 */
    getState: () => ipcRenderer.invoke('mp:tray:get-state'),
    /** 托盘窗口 ← 主进程：状态广播。 */
    onState: (callback) => subscribe('mp:tray:state', callback),
    /** 主窗口 ← 主进程：托盘菜单/卡片发来的命令（{type:'like'|'local-mute'}）。 */
    onCommand: (callback) => subscribe('mp:tray:command', callback),
    /** 托盘窗口 → 主进程：发送命令（转发给主窗口执行）。 */
    sendCommand: (type, payload) =>
      ipcRenderer.send('mp:tray:command', {
        type: String(type || ''),
        payload: payload && typeof payload === 'object' ? payload : undefined
      }),
    showMain: () => ipcRenderer.send('mp:tray:show-main'),
    hideCard: () => ipcRenderer.send('mp:tray:hide-card'),
    quitApp: () => ipcRenderer.send('mp:tray:quit')
  },
  lyrics: {
    toggle: () => ipcRenderer.send('mp:lyrics:toggle'),
    setState: (state) => ipcRenderer.send('mp:lyrics:set-state', state),
    setSpectrum: (bins) => ipcRenderer.send('mp:lyrics:spectrum', bins),
    showLike: (payload) => ipcRenderer.send('mp:lyrics:like-event', payload),
    onCommand: (callback) => subscribe('mp:lyrics:command', callback),
    onMaterialError: (callback) => subscribe('mp:lyrics:material-error', callback),
    resetBounds: () => ipcRenderer.send('mp:lyrics:reset-bounds'),
    isOpen: () => ipcRenderer.invoke('mp:lyrics:is-open'),
    onVisibility: (callback) => subscribe('mp:lyrics:visibility', callback)
  },
  http: {
    /**
     * 免 CORS 的 HTTP 桥。主进程不跟随重定向：3xx 返回
     * `{ ok:false, status, redirected:true, location, crossOrigin, error:'redirect-blocked' }`。
     * options.timeout（ms）为超时；未知字段忽略。
     */
    request: (options) => ipcRenderer.invoke('mp:http:request', options)
  }
})

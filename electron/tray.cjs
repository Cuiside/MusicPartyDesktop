'use strict'

/**
 * MusicParty 系统托盘模块（Electron 主进程，CommonJS）。
 *
 * 职责：
 *  - 用 build/icon.ico 创建系统托盘（打包后回退到 exe 自身图标）
 *  - 左键点击托盘 → 弹出 / 收起「托盘状态卡」小窗口（frameless，加载 `?tray=1`）
 *  - 右键菜单：当前歌曲（只读）/ 显示主界面 / 本地静音（复选）/ 退出应用
 *  - 缓存主窗口推送的 `{ title, artist, coverUrl, liked, muted, playing }`，
 *    实时转发给状态卡窗口并更新 tooltip
 *  - 把状态卡 / 右键菜单里的 `like`、`local-mute` 命令转发回主窗口执行
 *  - 自动化模式（MP_SHOT / MP_EVAL）不创建托盘与状态卡窗口，但保留 IPC（供 dev 预览）
 *
 * 渲染层契约（preload 暴露 `window.mpDesktop.tray`）见 docs/LOCAL_AUDIO_TRAY.md。
 */

const path = require('node:path')
const https = require('node:https')

const CARD_WIDTH = 380
const CARD_HEIGHT = 250
const CARD_GAP = 8
const TOOLTIP_MAX = 96

const DEFAULT_TRAY_STATE = Object.freeze({
  title: '',
  artist: '',
  coverUrl: '',
  liked: false,
  muted: false,
  playing: false
})

const STRING_LIMITS = { title: 160, artist: 80, coverUrl: 2048 }
const KNOWN_COMMANDS = new Set(['show-main', 'hide-card', 'quit', 'like', 'local-mute'])

const IS_WINDOWS = process.platform === 'win32'

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function clampText(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > limit ? text.slice(0, limit) : text
}

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** 只接受契约内的字段，非法类型直接忽略。 */
function normalizeStatePatch(patch) {
  const out = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const key of ['title', 'artist', 'coverUrl']) {
    if (hasOwn(patch, key) && typeof patch[key] === 'string') {
      out[key] = clampText(patch[key], STRING_LIMITS[key])
    }
  }
  for (const key of ['liked', 'muted', 'playing']) {
    if (hasOwn(patch, key) && typeof patch[key] === 'boolean') out[key] = patch[key]
  }
  return out
}

function normalizeCommand(raw) {
  if (!raw || typeof raw !== 'object') return null
  const type = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (!KNOWN_COMMANDS.has(type)) return null
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : undefined
  return { type, payload }
}

/**
 * 解析托盘图标：
 *  1. build/icon.ico（开发期 / 未打包）
 *  2. `app.getFileIcon(process.execPath)`（打包后 exe 已内嵌 build/icon.ico）
 *  3. 托盘不可用（返回 null，降级为“无托盘”：关闭询问不提供隐藏到托盘）
 */
async function resolveTrayIcon({ app, nativeImage, iconPath }) {
  try {
    if (iconPath) {
      const image = nativeImage.createFromPath(iconPath)
      if (image && !image.isEmpty()) return image
    }
  } catch {
    /* ignore */
  }
  try {
    const exe = app.getPath('exe')
    const image = await app.getFileIcon(exe, { size: 'small' })
    if (image && !image.isEmpty()) return image
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 注册系统托盘。必须在 app.whenReady() 之后调用。
 *
 * @param {object} options
 * @param {import('electron').App} options.app
 * @param {import('electron').IpcMain} options.ipcMain
 * @param {typeof import('electron').Tray} options.Tray
 * @param {typeof import('electron').Menu} options.Menu
 * @param {typeof import('electron').BrowserWindow} options.BrowserWindow
 * @param {typeof import('electron').nativeImage} options.nativeImage
 * @param {typeof import('electron').screen} options.screen
 * @param {typeof import('electron').shell} options.shell
 * @param {() => import('electron').BrowserWindow | null} options.getMainWindow
 * @param {boolean} [options.isDev] 开发模式：状态卡加载 Vite dev server
 * @param {boolean} [options.isAutomated] MP_SHOT / MP_EVAL 自动化运行：不创建托盘
 * @param {() => void} options.showMainWindow 显示主窗口
 * @param {() => void} options.quitApp 退出应用（主进程负责绕过 close 拦截）
 * @param {string} options.iconPath 托盘图标路径（build/icon.ico）
 * @param {string} options.distIndex 打包后的 dist/index.html
 * @param {string} [options.devServerUrl] 开发服务器地址，默认 http://localhost:5173
 * @returns {Promise<object>} tray 控制器
 */
async function registerTray(options = {}) {
  const {
    app,
    ipcMain,
    Tray,
    Menu,
    BrowserWindow,
    nativeImage,
    screen,
    shell,
    getMainWindow,
    isDev = false,
    isAutomated = false,
    showMainWindow,
    quitApp,
    iconPath,
    distIndex,
    devServerUrl = 'http://localhost:5173'
  } = options

  if (!app || typeof app.getPath !== 'function') {
    throw new TypeError('registerTray 需要合法的 Electron app')
  }
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('registerTray 需要合法的 ipcMain')
  }

  const state = { ...DEFAULT_TRAY_STATE }
  /** @type {import('electron').Tray | null} */
  let tray = null
  /** @type {import('electron').BrowserWindow | null} */
  let cardWin = null
  let destroyed = false
  let ipcRegistered = false
  let menuCover = null
  let coverGeneration = 0

  // Only established cover CDN hosts; never follow redirects or fetch arbitrary LAN URLs.
  function loadMenuCover(raw) {
    const generation = ++coverGeneration
    menuCover = null
    let url
    try { url = new URL(raw) } catch { return }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !/(^|\.)(music\.126\.net|hdslb\.com|biliimg\.com)$/.test(url.hostname.toLowerCase())) return
    const req = https.get(url, { timeout: 5000 }, response => {
      if (response.statusCode !== 200 || !/^image\//i.test(response.headers['content-type'] || '')) { response.resume(); return }
      let size = 0; const chunks = []
      response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(); else chunks.push(chunk) })
      response.on('end', () => {
        if (generation !== coverGeneration || size > 2 * 1024 * 1024) return
        try { const img = nativeImage.createFromBuffer(Buffer.concat(chunks)); if (!img.isEmpty()) menuCover = img.resize({ width: 24, height: 24 }) } catch {}
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => {})
  }
  /** 最近一次状态卡失焦时间：点击托盘图标时窗口会先失焦，需要区分“关闭”与“重新打开”。 */
  let lastCardBlurAt = 0

  function getMainWindowSafe() {
    try {
      return typeof getMainWindow === 'function' ? getMainWindow() : null
    } catch {
      return null
    }
  }

  function sendToMain(channel, payload) {
    const win = getMainWindowSafe()
    if (!win || win.isDestroyed()) return false
    try {
      win.webContents.send(channel, payload)
      return true
    } catch {
      return false
    }
  }

  function tooltipText() {
    if (state.title) {
      return `Music Party — ${truncate(state.title, TOOLTIP_MAX)}`
    }
    return 'Music Party'
  }

  function syncTooltip() {
    if (!tray) return
    try {
      tray.setToolTip(tooltipText())
    } catch {
      /* ignore */
    }
  }

  function broadcastState() {
    if (!cardWin || cardWin.isDestroyed()) return
    try {
      cardWin.webContents.send('mp:tray:state', { ...state })
    } catch {
      /* ignore */
    }
  }

  function mergeState(patch) {
    const clean = normalizeStatePatch(patch)
    if (Object.prototype.hasOwnProperty.call(clean, 'coverUrl') && clean.coverUrl !== state.coverUrl) loadMenuCover(clean.coverUrl)
    let changed = false
    for (const [key, value] of Object.entries(clean)) {
      if (state[key] !== value) {
        state[key] = value
        changed = true
      }
    }
    if (changed) {
      syncTooltip()
      broadcastState()
    }
    return changed
  }

  function buildContextMenu() {
    const items = []
    items.push({
      label: state.title ? truncate(state.title, 48) : '暂无播放',
      ...(menuCover ? { icon: menuCover } : {}),
      enabled: false
    })
    if (state.title && state.artist) {
      items.push({ label: truncate(state.artist, 48), enabled: false })
    }
    items.push({ type: 'separator' })
    items.push({
      label: '显示主界面',
      click: () => {
        if (typeof showMainWindow === 'function') showMainWindow()
      }
    })
    items.push({
      label: '本地静音',
      type: 'checkbox',
      checked: Boolean(state.muted),
      click: () => handleCommand({ type: 'local-mute' })
    })
    items.push({ type: 'separator' })
    items.push({
      label: '退出应用',
      click: () => {
        if (typeof quitApp === 'function') quitApp()
      }
    })
    return Menu.buildFromTemplate(items)
  }

  function handleCommand(raw) {
    const command = normalizeCommand(raw)
    if (!command) return
    if (command.type === 'show-main') {
      if (typeof showMainWindow === 'function') showMainWindow()
    } else if (command.type === 'hide-card') {
      hideCard()
    } else if (command.type === 'quit') {
      if (typeof quitApp === 'function') quitApp()
    } else {
      // like / local-mute：交给主窗口执行（主窗口执行后再推送最新状态）
      sendToMain('mp:tray:command', { type: command.type })
    }
  }

  async function createTray() {
    if (isAutomated || destroyed || tray) return
      const icon = await resolveTrayIcon({ app, nativeImage, iconPath })
    if (!icon) {
      console.warn('[tray] 托盘图标不可用，跳过系统托盘（关闭询问将不提供“隐藏到托盘”）')
      return
    }
    // Keep the original multi-resolution ICO: downsampling it to 16 px here
    // discards the high-DPI representations Windows needs for the overflow panel.
    tray = new Tray(icon)
    syncTooltip()
    console.log('[tray] 系统托盘已创建（左键状态卡 / 右键菜单）')
    tray.on('click', () => toggleCard())
    tray.on('double-click', () => {
      if (typeof showMainWindow === 'function') showMainWindow()
    })
    tray.on('right-click', () => {
      if (!tray) return
      try {
        tray.popUpContextMenu(buildContextMenu())
      } catch (error) {
        console.warn('[tray] popUpContextMenu failed', error)
      }
    })
  }

  function ensureCardWindow() {
    if (cardWin && !cardWin.isDestroyed()) return cardWin
    if (destroyed || isAutomated) return null
    cardWin = new BrowserWindow({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      backgroundColor: '#ffcd38',
      title: 'Music Party 托盘',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    try {
      cardWin.setAlwaysOnTop(true, 'pop-up-menu')
    } catch {
      /* ignore */
    }
    cardWin.on('blur', () => {
      lastCardBlurAt = Date.now()
      if (isDev) return
      hideCard()
    })
    cardWin.on('close', (event) => {
      if (destroyed) return
      event.preventDefault()
      hideCard()
    })
    cardWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && shell && typeof shell.openExternal === 'function') {
        shell.openExternal(url).catch?.(() => {})
      }
      return { action: 'deny' }
    })
    cardWin.webContents.once('did-finish-load', () => {
      console.log('[tray] 状态卡窗口已加载（?tray=1）')
    })
    cardWin.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.warn(`[tray] 状态卡加载失败 code=${code} ${description} ${url}`)
    })
    if (isDev) {
      const base = String(devServerUrl).replace(/\/+$/, '')
      cardWin.loadURL(`${base}/?tray=1`)
    } else {
      cardWin.loadFile(distIndex, { query: { tray: '1' } })
    }
    return cardWin
  }

  function positionCard() {
    if (!cardWin || cardWin.isDestroyed()) return
    try {
      const [width, height] = cardWin.getSize()
      let trayBounds = null
      try {
        if (tray && typeof tray.getBounds === 'function') {
          const bounds = tray.getBounds()
          if (bounds && (bounds.width || bounds.height)) trayBounds = bounds
        }
      } catch {
        trayBounds = null
      }
      let anchorX
      let anchorY
      if (trayBounds) {
        anchorX = trayBounds.x + trayBounds.width / 2
        anchorY = trayBounds.y
      } else {
        const point = screen.getCursorScreenPoint()
        anchorX = point.x
        anchorY = point.y
      }
      const display = screen.getDisplayNearestPoint({
        x: Math.round(anchorX),
        y: Math.round(anchorY)
      })
      const work = display.workArea
      let x = Math.round(anchorX - width / 2)
      let y
      if (trayBounds && trayBounds.y > work.y + work.height / 2) {
        // 任务栏在屏幕下方：卡片放在任务栏图标上方
        y = Math.round(trayBounds.y - height - CARD_GAP)
      } else if (trayBounds) {
        // 任务栏在屏幕上方：卡片放在下方
        y = Math.round(trayBounds.y + trayBounds.height + CARD_GAP)
      } else {
        y = Math.round(anchorY - height - CARD_GAP)
      }
      x = Math.min(Math.max(x, work.x + CARD_GAP), work.x + work.width - width - CARD_GAP)
      y = Math.min(Math.max(y, work.y + CARD_GAP), work.y + work.height - height - CARD_GAP)
      cardWin.setPosition(x, y)
    } catch {
      /* 定位失败时保持默认位置 */
    }
  }

  function showCard() {
    if (destroyed || isAutomated) return false
    const win = ensureCardWindow()
    if (!win) return false
    positionCard()
    broadcastState()
    try {
      win.show()
      win.focus()
    } catch {
      return false
    }
    console.log('[tray] 状态卡窗口已显示')
    return true
  }

  function hideCard() {
    if (!cardWin || cardWin.isDestroyed()) return
    try {
      if (cardWin.isVisible()) cardWin.hide()
    } catch {
      /* ignore */
    }
  }

  function toggleCard() {
    const visible = Boolean(cardWin && !cardWin.isDestroyed() && cardWin.isVisible())
    if (visible) {
      hideCard()
      return
    }
    // 点击托盘图标会先让状态卡失焦（已自动隐藏），此时这次点击应视为“收起”，
    // 否则会出现“点一下关不掉”的观感。
    if (Date.now() - lastCardBlurAt < 400) return
    showCard()
  }

  function registerIpc() {
    if (ipcRegistered) return
    ipcRegistered = true
    ipcMain.on('mp:tray:set-state', (_event, patch) => {
      mergeState(patch)
    })
    ipcMain.handle('mp:tray:get-state', () => ({ ...state }))
    ipcMain.on('mp:tray:command', (_event, command) => {
      handleCommand(command)
    })
    ipcMain.on('mp:tray:show-main', () => {
      if (typeof showMainWindow === 'function') showMainWindow()
    })
    ipcMain.on('mp:tray:hide-card', () => hideCard())
    ipcMain.on('mp:tray:quit', () => {
      if (typeof quitApp === 'function') quitApp()
    })
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    coverGeneration++
    if (cardWin && !cardWin.isDestroyed()) {
      try {
        cardWin.removeAllListeners('close')
        cardWin.destroy()
      } catch {
        /* ignore */
      }
    }
    cardWin = null
    if (tray) {
      try {
        tray.destroy()
      } catch {
        /* ignore */
      }
    }
    tray = null
  }

  /** dev 验证用：读取状态卡窗口里实际渲染的标题/歌手/状态文本。 */
  async function readCardSnapshot() {
    if (!cardWin || cardWin.isDestroyed()) return null
    const script = `JSON.stringify({ title: (document.querySelector('.tc-title') || {}).textContent || '', artist: (document.querySelector('.tc-artist') || {}).textContent || '', status: (document.querySelector('.tc-state') || {}).textContent || '' })`
    try {
      const raw = await cardWin.webContents.executeJavaScript(script, true)
      return typeof raw === 'string' ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  const controller = {
    get enabled() {
      return Boolean(tray)
    },
    get state() {
      return { ...state }
    },
    mergeState,
    showCard,
    hideCard,
    toggleCard,
    getState: () => ({ ...state }),
    readCardSnapshot,
    destroy
  }

  registerIpc()
  if (isAutomated) {
    console.log('[tray] 自动化模式（MP_SHOT/MP_EVAL）：不创建系统托盘')
    return controller
  }
  try {
    await createTray()
  } catch (error) {
    console.warn('[tray] 创建系统托盘失败，已降级为无托盘模式', error)
  }
  return controller
}

module.exports = {
  registerTray,
  DEFAULT_TRAY_STATE,
  CARD_WIDTH,
  CARD_HEIGHT
}

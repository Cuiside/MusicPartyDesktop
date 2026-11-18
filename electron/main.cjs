'use strict'

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  Notification,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  shell
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const fsp = require('node:fs/promises')
const { spawn } = require('node:child_process')
const { registerLauncher } = require('./launcher.cjs')
const { createHttpBridgeHandler } = require('./http-bridge.cjs')
const { registerTray } = require('./tray.cjs')

const isDev = process.env.MP_DEV === '1'
const isShot = process.env.MP_SHOT === '1'
const shotView = process.env.MP_SHOT_VIEW || ''
const shotOut = process.env.MP_SHOT_OUT || 'screenshots/window.png'
const shotWait = Number(process.env.MP_SHOT_WAIT || 1800)
const winWidth = Number(process.env.MP_SHOT_W || 1440)
const winHeight = Number(process.env.MP_SHOT_H || 900)
// Interaction harness: evaluate JS in the renderer, print the result, then exit
// (optionally capturing a screenshot first). Used by the QA scripts.
const evalCode = process.env.MP_EVAL || ''
const evalFile = process.env.MP_EVAL_FILE || ''
const evalWait = Number(process.env.MP_EVAL_WAIT || 1500)
const hasEval = Boolean(evalCode || evalFile)
// Dev-only: simulate a close request shortly after load so the close dialog can be
// screenshotted (`MP_CLOSE_PROMPT=1` + MP_SHOT) without intercepting real closes.
const isClosePromptPreview = process.env.MP_CLOSE_PROMPT === '1'
// Automated runs (screenshots / eval) never intercept window close and never build
// a system tray; they would otherwise block the harness from exiting.
const isAutomated = isShot || hasEval
function appIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico')
}

// Deterministic captures on high-DPI machines for the screenshot harness only.
// (Never force it for the real app: on Windows 125%/150% displays that made the
// whole UI render tiny.)
if (isShot) app.commandLine.appendSwitch('force-device-scale-factor', '1')
// Music app: allow playback to start without a user gesture (sync follows the room).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Screenshot/eval runs may overlap with the real app or each other; give each
// process its own profile so Chromium's cache locks never collide.
if (isShot || evalCode || evalFile) {
  app.setPath('userData', path.join(require('node:os').tmpdir(), `mp-shot-${process.pid}`))
}
// The close-flow harness must never use the user's real profile.
if (process.env.MP_CLOSE_PROMPT === '1' && process.env.MP_CLOSE_TEST_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MP_CLOSE_TEST_DATA_DIR))
}
if (process.platform === 'win32') {
  app.setName('Music Party')
  app.setAppUserModelId(app.isPackaged ? 'com.musicparty.desktop' : 'com.musicparty.desktop.development')
}

/** @type {BrowserWindow | null} */
let win = null
let pendingInstantChat = 0
let instantChatSequence = 0
let instantChatRendererReady = false
function deliverInstantChatNavigation() {
  if (!pendingInstantChat || !instantChatRendererReady || !win || win.isDestroyed()) return
  win.webContents.send('mp:chat:open-instant', pendingInstantChat)
}

/* ---------- close-to-tray / system tray state ---------- */
/** @type {Awaited<ReturnType<typeof registerTray>> | null} */
let trayController = null
/** 置 true 后窗口 close 不再被拦截（退出应用 / 自动化模式）。 */
let allowClose = false
let closeRequestSeq = 0
/** @type {null | { id: number, canTray: boolean, timer: NodeJS.Timeout }} */
let pendingCloseRequest = null
let rendererAvailable = false
let launcherController = null
const closePreferenceFile = () => path.join(app.getPath('userData'), 'close-preference.json')
function readClosePreference() {
  try { const value = JSON.parse(fs.readFileSync(closePreferenceFile(), 'utf8')).action; return ['tray', 'close'].includes(value) ? value : 'ask' } catch { return 'ask' }
}
function writeClosePreference(value) {
  if (launcherController?.isClearingLocalData()) throw new Error('正在清除本地数据，请稍后再修改关闭设置')
  const action = ['tray', 'close'].includes(value) ? value : 'ask'
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(closePreferenceFile(), JSON.stringify({ action }), { mode: 0o600 })
  return action
}

function hideToTrayAvailable() {
  try {
    return Boolean(trayController && trayController.enabled)
  } catch {
    return false
  }
}

/** 从托盘 / 二次启动 / 托盘卡片调用：恢复并聚焦主窗口。 */
function showMainWindow() {
  if (!win || win.isDestroyed()) {
    if (app.isReady()) createWindow()
    return
  }
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } catch {
    /* window may be tearing down */
  }
  try {
    if (trayController) trayController.hideCard()
  } catch {
    /* ignore */
  }
}

/** 真正退出应用：先放行 close 拦截，再走正常 quit 流程（launcher/tray 各自清理）。 */
function quitNow() {
  allowClose = true
  if (pendingCloseRequest) {
    clearTimeout(pendingCloseRequest.timer)
    pendingCloseRequest = null
  }
  app.quit()
}

function applyCloseAction(action) {
  if (action === 'tray') {
    if (!hideToTrayAvailable()) {
      // 托盘不可用（无图标/自动化）时不允许把窗口藏到无法恢复的地方。
      return
    }
    try {
      if (win && !win.isDestroyed()) win.hide()
    } catch {
      /* ignore */
    }
    return
  }
  if (action === 'close') quitNow()
  // 'cancel' / 非法值：什么都不做
}

function resolveCloseResponse(payload) {
  if (!pendingCloseRequest) return
  const source = payload && typeof payload === 'object' ? payload : {}
  const id = typeof source.id === 'number' ? source.id : null
  if (id != null && pendingCloseRequest.id !== id) return
  const action = source.action
  if (source.remember && ['tray', 'close'].includes(action)) {
    try { writeClosePreference(action) } catch (error) { console.warn('[close] 无法保存关闭偏好:', error.message) }
  }
  clearTimeout(pendingCloseRequest.timer)
  pendingCloseRequest = null
  applyCloseAction(action)
}

/** 发起一次关闭询问；返回是否真的发出（已有待处理询问时返回 false）。 */
function requestCloseDecision() {
  if (allowClose || isAutomated) return false
  if (!win || win.isDestroyed()) return false
  if (!rendererAvailable || win.webContents.isLoading()) { quitNow(); return true }
  if (pendingCloseRequest) return false
  const preference = readClosePreference()
  if (preference === 'close' || (preference === 'tray' && hideToTrayAvailable())) {
    applyCloseAction(preference)
    return true
  }
  const id = ++closeRequestSeq
  const canTray = hideToTrayAvailable()
  // If the renderer never answers, let the user try the close button again.
  // Do not auto-quit: the user may have unsaved work or an open prompt.
  const timer = setTimeout(() => {
    if (pendingCloseRequest?.id === id) pendingCloseRequest = null
  }, 15000)
  pendingCloseRequest = { id, canTray, timer }
  try {
    win.webContents.send('mp:window:close-request', { id, canTray })
  } catch {
    // If sending is impossible, leave the window open rather than stack dialogs.
    clearTimeout(timer)
    pendingCloseRequest = null
  }
  return true
}

/** win.on('close') 拦截：自动化模式/退出流程直接放行。 */
function onWindowClose(event) {
  if (allowClose || isAutomated) return
  event.preventDefault()
  requestCloseDecision()
}

/** dev 参数 MP_CLOSE_PROMPT=1：加载完成后模拟一次关闭询问，供截图/手测。
 *  - MP_SHOT/MP_EVAL 场景下只派发一次展示事件（preview，不影响真实关闭）；
 *  - 非自动化场景 + `MP_CLOSE_PROMPT_ACTION=tray|cancel|close` 时走完整链路
 *    （requestCloseDecision → 渲染层 respondClose → 主进程执行动作），用于自动化验证。 */
function scheduleClosePromptPreview() {
  if (!isClosePromptPreview || !win) return
  const simulateAction = process.env.MP_CLOSE_PROMPT_ACTION || ''
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      if (!isAutomated && simulateAction) {
        if (process.env.MP_CLOSE_TEST_CRASH_BEFORE === '1') {
          win.webContents.once('render-process-gone', () => setTimeout(() => { if (win && !win.isDestroyed()) win.close() }, 100))
          win.webContents.forcefullyCrashRenderer()
          return
        }
        const sent = requestCloseDecision()
        console.log(
          `[close-prompt] real close request sent=${sent} canTray=${hideToTrayAvailable()} action=${simulateAction}`
        )
        if (process.env.MP_CLOSE_TEST_CRASH === '1') {
          setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer() }, 200)
          return
        }
        setTimeout(async () => {
          const script = `(window.mpDesktop && window.mpDesktop.window && window.mpDesktop.window.respondClose(${JSON.stringify(simulateAction)}, ${process.env.MP_CLOSE_PROMPT_REMEMBER === '1'}), 'sent')`
          try {
            const result = await win.webContents.executeJavaScript(script, true)
            console.log(`[close-prompt] simulated respondClose(${simulateAction}) -> ${result}`)
          } catch (error) {
            console.warn('[close-prompt] simulated respondClose failed', error)
          }
          setTimeout(() => {
            let visible = false
            try {
              visible = Boolean(win && !win.isDestroyed() && win.isVisible())
            } catch {
              /* ignore */
            }
            console.log(`[close-prompt] result action=${simulateAction} winVisible=${visible}`)
            allowClose = true
            app.quit()
          }, 600)
        }, Math.max(0, Number(process.env.MP_CLOSE_PROMPT_ACTION_DELAY || 450)))
        return
      }
      try {
        win.webContents.send('mp:window:close-request', {
          id: ++closeRequestSeq,
          canTray: true,
          preview: true
        })
        console.log('[close-prompt] preview close-request sent (MP_CLOSE_PROMPT=1)')
      } catch (error) {
        console.warn('[close-prompt] preview failed', error)
      }
    }, 900)
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    // Screenshot runs may capture non-app shells (e.g. the ?tray=1 card window)
    // at sizes far below the real app minimum; only enforce minimums for the app.
    ...(isShot ? {} : { minWidth: 1024, minHeight: 680 }),
    show: false,
    frame: false,
    icon: appIconPath(),
    backgroundColor: '#ffcd38',
    title: 'Music Party',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Keep CSS transitions / rAF running when the window is hidden or
      // minimized (needed for screenshots and background playback state).
      backgroundThrottling: false
    }
  })
  try {
    const icon = nativeImage.createFromPath(appIconPath())
    if (!icon.isEmpty()) win.setIcon(icon)
  } catch {}

  win.once('ready-to-show', () => {
    if (!isShot) win.show()
    applyUiZoom()
  })

  // 关闭按钮 / Alt+F4 / 原生关闭全部走这里：非自动化模式下询问「关闭应用 / 隐藏到托盘 / 取消」。
  win.on('close', onWindowClose)
  win.on('closed', () => {
    instantChatRendererReady = false
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close()
    win = null
  })
  // Do not stack a native dialog over the renderer prompt. If the renderer is
  // reloading, allow a subsequent close request; if it has crashed/hung after
  // the user requested close, exit instead of leaving an unclosable window.
  win.webContents.on('did-start-loading', () => { rendererAvailable = false; instantChatRendererReady = false; if (pendingCloseRequest) pendingCloseRequest = null })
  win.webContents.on('did-finish-load', () => { rendererAvailable = true })
  win.webContents.on('render-process-gone', () => { rendererAvailable = false; instantChatRendererReady = false; if (pendingCloseRequest) quitNow() })
  win.on('unresponsive', () => { rendererAvailable = false; if (pendingCloseRequest) quitNow() })
  win.on('responsive', () => { rendererAvailable = true })

  /* ---------- adaptive UI scale ----------
     The layout is authored at 1440x900 CSS px. Inside bigger windows (maximize /
     fullscreen / large monitors) the whole UI scales up with the window instead
     of leaving a small layout swimming in empty space. On smaller windows the
     scale stays 1 so the 1024 minimum still works. Screenshot mode is always 1. */
  const UI_BASE_W = 1440
  const UI_BASE_H = 900
  const getUiZoom = () => {
    if (isShot) return 1
    if (!win || win.isDestroyed()) return 1
    const [width, height] = win.getContentSize()
    const ratio = Math.min(width / UI_BASE_W, height / UI_BASE_H)
    return Math.min(1.75, Math.max(1, Math.round(ratio * 100) / 100))
  }
  const applyUiZoom = () => {
    if (isShot) return
    if (!win || win.isDestroyed() || !win.webContents) return
    try {
      win.webContents.setZoomFactor(getUiZoom())
    } catch {
      /* window may be tearing down */
    }
  }
  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, applyUiZoom)
  }
  win.webContents.on('did-finish-load', applyUiZoom)

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      event.preventDefault()
      win.setFullScreen(!win.isFullScreen())
    } else if (input.control && input.key === '0') {
      event.preventDefault()
      try {
        win.webContents.setZoomFactor(getUiZoom())
      } catch {
        /* ignore */
      }
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const extra = Object.fromEntries(new URLSearchParams(process.env.MP_SHOT_EXTRA || ''))
  const query = {
    ...(shotView ? { view: shotView } : {}),
    ...(isShot ? { shot: '1' } : {}),
    ...(hasEval ? { eval: '1' } : {}),
    ...extra
  }
  if (isDev) {
    const qs = new URLSearchParams(query).toString()
    win.loadURL(`http://localhost:5173/?${qs}`)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query })
  }

  if (isShot || hasEval) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (isShot) {
          // Hidden windows stop producing BeginFrames, so capturePage would
          // return a stale frame (e.g. a transition frozen at 7px). Make the
          // window "visible" without stealing focus or being seen, and strip
          // entrance animations so captures always show the settled state.
          try {
            win.webContents.insertCSS(
              '*,*::before,*::after{transition:none!important;animation:none!important}'
            )
            win.setOpacity(0)
            win.showInactive()
          } catch {
            /* ignore */
          }
          await new Promise((resolve) => setTimeout(resolve, 120))
        }
        if (hasEval) {
          const code = evalCode || fs.readFileSync(evalFile, 'utf8')
          try {
            const result = await win.webContents.executeJavaScript(code, true)
            console.log(`[eval] result ${JSON.stringify(result)}`)
            try {
              console.log(`[eval] window=${JSON.stringify(win.getContentSize())} zoom=${win.webContents.getZoomFactor()}`)
            } catch {
              /* ignore */
            }
          } catch (error) {
            console.error(`[eval] failed ${String(error)}`)
          }
        }
        if (isShot) {
          try {
            await new Promise((resolve) => setTimeout(resolve, isShot && hasEval ? 400 : 0))
            const image = await win.webContents.capturePage()
            const abs = path.resolve(process.cwd(), shotOut)
            await fsp.mkdir(path.dirname(abs), { recursive: true })
            await fsp.writeFile(abs, image.toPNG())
            console.log(`[shot] written ${abs}`)
          } catch (err) {
            console.error('[shot] failed', err)
          }
        }
        app.exit(0)
      }, hasEval ? evalWait : shotWait)
    })
  }

  // dev-only：用于截图/手测关闭询问框（MP_CLOSE_PROMPT=1）。
  scheduleClosePromptPreview()
}

/* ---------- desktop lyrics ---------- */
let lyricsWindow = null
let lyricsBackdropWindow = null
let lyricsState = { text: '', trans: '', color: '#ffffff', font: 'default', border: false, borderWidth: 2, borderOpacity: 70, glass: false, fontSize: 26 }
let lyricsBounds = null
let lyricsResize = null
let lyricsMaterialBusy = false
let lyricsMaterialPending = null
let lyricsMaterialFailureNotified = false

function lyricsGlassWindowOpacity(value) {
  const transparency = Math.max(0, Math.min(100, Number(value) || 0))
  if (transparency >= 100) return 0
  // Keep the native acrylic material enabled and fade only the dedicated
  // background window. This avoids the abrupt acrylic -> transparent switch
  // that occurs when SetWindowCompositionAttribute modes are changed.
  return Math.max(0.06, 0.92 - transparency * 0.0086)
}

function setLyricsBackdropOpacity(target) {
  if (!lyricsBackdropWindow || lyricsBackdropWindow.isDestroyed()) return
  const backdrop = lyricsBackdropWindow
  const next = Math.max(0, Math.min(1, Number(target) || 0))
  const start = Number.isFinite(backdrop._lyricsOpacity) ? backdrop._lyricsOpacity : 0
  if (next > 0) {
    try { backdrop.showInactive() } catch {}
    try {
      if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.moveTop()
    } catch {}
  }
  backdrop._lyricsOpacity = next
  try { backdrop.setOpacity(next) } catch {}
  if (next === 0) { try { backdrop.hide() } catch {} }
}

function closeLyricsBackdrop() {
  const backdrop = lyricsBackdropWindow
  lyricsBackdropWindow = null
  if (backdrop && !backdrop.isDestroyed()) {
    try { backdrop.close() } catch { try { backdrop.destroy() } catch {} }
  }
}

function ensureLyricsBackdrop(bounds) {
  if (process.platform !== 'win32') return null
  if (lyricsBackdropWindow && !lyricsBackdropWindow.isDestroyed()) return lyricsBackdropWindow
  const backdrop = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  lyricsBackdropWindow = backdrop
  backdrop._lyricsOpacity = 0
  try { backdrop.setIgnoreMouseEvents(true) } catch {}
  try { backdrop.setAlwaysOnTop(true, 'floating') } catch {}
  backdrop.on('closed', () => {
    if (lyricsBackdropWindow === backdrop) lyricsBackdropWindow = null
  })
  backdrop.loadURL('about:blank')
  return backdrop
}

function queueNativeLyricsMaterial(windowRef, transparency) {
  if (process.platform !== 'win32' || !windowRef || windowRef.isDestroyed()) return
  lyricsMaterialPending = { windowRef, transparency }
  if (lyricsMaterialBusy) return
  const currentMaterialWindow = () => typeof lyricsBackdropWindow !== 'undefined' ? lyricsBackdropWindow : (typeof lyricsWindow !== 'undefined' ? lyricsWindow : null)
  const stillCurrent = task => task.windowRef === currentMaterialWindow() && !task.windowRef.isDestroyed() && (task.transparency < 0 ? (!lyricsState.glass || lyricsState.glassOpacity >= 100) : (lyricsState.glass && lyricsState.glassOpacity < 100))
  const reportFailure = task => {
    if (!stillCurrent(task)) return
    if (task.transparency >= 0) {
      try { task.windowRef.setBackgroundMaterial('acrylic') } catch {}
      if (!lyricsMaterialFailureNotified && win && !win.isDestroyed()) { lyricsMaterialFailureNotified = true; win.webContents.send('mp:lyrics:material-error') }
    } else if (task.windowRef._lyricsNativeTouched) {
      // A failed disable may leave the old native accent visible. Remove only
      // the dedicated background layer; the transparent lyric window remains usable.
      task.windowRef._lyricsNativeTouched = false
      try { task.windowRef.destroy() } catch {}
    }
  }
  const next = () => {
    const task = lyricsMaterialPending; lyricsMaterialPending = null
    if (!task || task.windowRef.isDestroyed()) { lyricsMaterialBusy = false; return }
    const executable = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'lyrics-glass.exe') : path.join(__dirname, '..', 'bin', 'lyrics-glass.exe')
    if (!fs.existsSync(executable)) {
      console.warn('[lyrics] native glass helper missing')
      reportFailure(task)
      lyricsMaterialBusy = false; return
    }
    const handle = task.windowRef.getNativeWindowHandle()
    const hwnd = (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString()
    lyricsMaterialBusy = true
    if (task.transparency >= 0) task.windowRef._lyricsNativeTouched = true
    // The backdrop always uses the acrylic material. Its BrowserWindow opacity
    // is the continuous transparency control; the helper only enables/disables
    // the material and is never switched between acrylic and gradient modes.
    const helperOpacity = task.transparency >= 0 ? 0 : -1
    const regionArgs = task.transparency >= 0 ? ['12'] : []
    const child = spawn(executable, [hwnd, String(process.pid), String(helperOpacity), ...regionArgs], { windowsHide:true, stdio:'ignore' })
    let settled = false
    const done = (code) => {
      if (settled) return; settled = true
      clearTimeout(timeout)
      if (code !== 0) {
        console.warn('[lyrics] native glass helper failed:', code)
        reportFailure(task)
      } else if (task.transparency < 0 && !task.windowRef.isDestroyed()) {
        task.windowRef._lyricsNativeTouched = false
      }
      lyricsMaterialBusy = false
      if (lyricsMaterialPending) next()
    }
    const timeout = setTimeout(() => { try { child.kill() } catch {}; done(-2) }, 2500)
    child.once('error', () => done(-1)); child.once('exit', done)
  }
  next()
}
const LYRICS_RATIO = 760 / 180
function setLyricsShape(windowRef, glass) {
  try {
    const [width, height] = windowRef.getContentSize()
    const radius = glass ? Math.min(12, Math.floor(width / 2), Math.floor(height / 2)) : 0
    const rows = []
    if (radius === 0) rows.push({ x: 0, y: 0, width, height })
    else {
      for (let y = 0; y < radius; y++) {
        const inset = Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - (radius - y - 0.5) ** 2)))
        rows.push({ x: inset, y, width: Math.max(1, width - inset * 2), height: 1 })
        rows.push({ x: inset, y: height - 1 - y, width: Math.max(1, width - inset * 2), height: 1 })
      }
      rows.push({ x: 0, y: radius, width, height: Math.max(1, height - radius * 2) })
    }
    windowRef.setShape(rows)
  } catch (error) { console.warn('[lyrics] window shape unavailable:', error.message) }
}
function applyLyricsMaterial(windowRef, glass) {
  if (!windowRef || windowRef.isDestroyed()) return
  try { windowRef.setBackgroundMaterial('none') } catch {}
  try { windowRef.setBackgroundColor('#00000000') } catch {}
  const nativeGlass = glass && (lyricsState.glassOpacity ?? 70) < 100
  if (nativeGlass) {
    const backdrop = typeof ensureLyricsBackdrop === 'function' ? ensureLyricsBackdrop(windowRef.getBounds()) : windowRef
    if (backdrop) {
      if (typeof setLyricsBounds === 'function' && typeof windowRef.getBounds === 'function') setLyricsBounds(backdrop, windowRef.getBounds())
      setLyricsShape(backdrop, true)
      if (!backdrop._lyricsNativeTouched) queueNativeLyricsMaterial(backdrop, 0)
      if (typeof setLyricsBackdropOpacity === 'function') setLyricsBackdropOpacity(lyricsGlassWindowOpacity(lyricsState.glassOpacity))
    }
  } else if (typeof lyricsBackdropWindow !== 'undefined' && lyricsBackdropWindow && !lyricsBackdropWindow.isDestroyed()) {
    if (lyricsBackdropWindow._lyricsNativeTouched) queueNativeLyricsMaterial(lyricsBackdropWindow, -1)
    if (typeof setLyricsBackdropOpacity === 'function') setLyricsBackdropOpacity(0)
  }
  // Keep the content window transparent. The dedicated backdrop is shaped too
  // so native material cannot protrude past the rounded corners.
  setLyricsShape(windowRef, glass)
}
// Programmatic setBounds is not guaranteed to emit the user-only `resized`
// event on Windows. Always refresh the native region after our own changes.
function setLyricsBounds(windowRef, bounds) {
  if (!windowRef || windowRef.isDestroyed()) return
  windowRef.setBounds(bounds)
  setLyricsShape(windowRef, lyricsState.glass)
  if (typeof lyricsWindow !== 'undefined' && typeof lyricsBackdropWindow !== 'undefined' && windowRef === lyricsWindow && lyricsBackdropWindow && !lyricsBackdropWindow.isDestroyed()) {
    lyricsBackdropWindow.setBounds(bounds)
    setLyricsShape(lyricsBackdropWindow, true)
    if (lyricsBackdropWindow._lyricsNativeTouched) queueNativeLyricsMaterial(lyricsBackdropWindow, 0)
  }
}
function defaultLyricsBounds() { const a = screen.getPrimaryDisplay().workArea; const w = Math.min(760, a.width), h = Math.round(w * 180 / 760); return { x: Math.round(a.x + (a.width-w)/2), y: Math.max(a.y, a.y+a.height-h-40), width:w, height:h } }
function sendLyricsVisibility() {
  if (win && !win.isDestroyed()) win.webContents.send('mp:lyrics:visibility', Boolean(lyricsWindow && !lyricsWindow.isDestroyed()))
}
function openLyricsWindow() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) return
  const bounds = lyricsBounds || defaultLyricsBounds()
  if (lyricsState.glass && (lyricsState.glassOpacity ?? 70) < 100) ensureLyricsBackdrop(bounds)
  const overlay = new BrowserWindow({
    ...bounds, frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'lyrics-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  try {
    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
    const icon = nativeImage.createFromPath(appIconPath())
    if (!icon.isEmpty()) overlay.setIcon(icon)
  } catch {}
  try { overlay.setAspectRatio(760 / 180) } catch {}
  lyricsWindow = overlay
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlay.webContents.on('will-navigate', (event) => event.preventDefault())
  overlay.webContents.on('did-finish-load', () => {
    if (!overlay.isDestroyed()) overlay.webContents.send('mp:lyrics:state', lyricsState)
  })
  overlay.once('ready-to-show', () => { if (!overlay.isDestroyed()) { applyLyricsMaterial(overlay, lyricsState.glass); overlay.showInactive(); try { overlay.moveTop() } catch {} } })
  overlay.on('closed', () => { if (lyricsWindow === overlay) lyricsWindow = null; lyricsResize = null; closeLyricsBackdrop(); sendLyricsVisibility() })
  const syncLyricsBackdrop = () => {
    if (overlay.isDestroyed()) return
    lyricsBounds = overlay.getBounds()
    if (lyricsBackdropWindow && !lyricsBackdropWindow.isDestroyed()) {
      lyricsBackdropWindow.setBounds(lyricsBounds)
      setLyricsShape(lyricsBackdropWindow, true)
    }
  }
  overlay.on('move', syncLyricsBackdrop)
  overlay.on('moved', syncLyricsBackdrop)
  overlay.on('resize', () => { if (!overlay.isDestroyed()) { lyricsBounds = overlay.getBounds(); setLyricsShape(overlay, lyricsState.glass); if (lyricsBackdropWindow && !lyricsBackdropWindow.isDestroyed()) { lyricsBackdropWindow.setBounds(lyricsBounds); setLyricsShape(lyricsBackdropWindow, true); if (lyricsBackdropWindow._lyricsNativeTouched) queueNativeLyricsMaterial(lyricsBackdropWindow, 0) } } })
  overlay.loadFile(path.join(__dirname, 'lyrics.html'))
  sendLyricsVisibility()
}
ipcMain.on('mp:lyrics:toggle', (event) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return
  if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close()
  else openLyricsWindow()
})
ipcMain.on('mp:lyrics:close', (event) => {
  if (lyricsWindow && !lyricsWindow.isDestroyed() && event.sender === lyricsWindow.webContents) lyricsWindow.close()
})
ipcMain.on('mp:lyrics:set-state', (event, state) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return
  lyricsState = {
    text: typeof state?.text === 'string' ? state.text.slice(0, 2000) : '',
    trans: typeof state?.trans === 'string' ? state.trans.slice(0, 2000) : '',
    color: /^#[0-9a-f]{6}$/i.test(state?.color || '') ? state.color : '#ffffff',
    font: ['default', 'sans', 'serif', 'rounded'].includes(state?.font) ? state.font : 'default',
    fill: state?.fill === true, wave: state?.wave === true, playing: state?.playing === true,
    border: state?.border === true,
    borderWidth: Number.isFinite(state?.borderWidth) ? Math.max(1, Math.min(10, state.borderWidth)) : 2,
    borderOpacity: Number.isFinite(state?.borderOpacity) ? Math.max(0, Math.min(100, state.borderOpacity)) : 70,
    glass: state?.glass === true,
    glassOpacity: Number.isFinite(state?.glassOpacity) ? Math.max(0, Math.min(100, state.glassOpacity)) : 70,
    spectrum: state?.spectrum === true, muted: state?.muted === true, liked: state?.liked === true,
    fontSize: Number.isFinite(state?.fontSize) ? Math.max(12, Math.min(80, state.fontSize)) : 26,
    time: Number.isFinite(state?.time) ? Math.max(0, state.time) : 0,
    start: Number.isFinite(state?.start) ? Math.max(0, state.start) : 0,
    end: Number.isFinite(state?.end) ? Math.max(0, state.end) : 0
  }
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    const materialKey = `${lyricsState.glass}:${lyricsState.glassOpacity}`
    if (lyricsWindow._lyricsMaterialKey !== materialKey) { applyLyricsMaterial(lyricsWindow, lyricsState.glass); lyricsWindow._lyricsMaterialKey = materialKey }
    lyricsWindow.webContents.send('mp:lyrics:state', lyricsState)
  }
})
ipcMain.on('mp:lyrics:command', (event, action) => {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || event.sender !== lyricsWindow.webContents || !['like','local-mute'].includes(action)) return
  if (win && !win.isDestroyed()) win.webContents.send('mp:lyrics:command', { type:action })
})
ipcMain.on('mp:lyrics:spectrum', (event, bins) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !lyricsWindow || lyricsWindow.isDestroyed() || !lyricsState.spectrum || !Array.isArray(bins) || bins.length > 64) return
  lyricsWindow.webContents.send('mp:lyrics:spectrum', bins.map(v => Math.max(0, Math.min(255, Number(v) || 0))))
})
ipcMain.on('mp:lyrics:like-event', (event, data) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !lyricsWindow || lyricsWindow.isDestroyed()) return
  lyricsWindow.webContents.send('mp:lyrics:like-event', { message:String(data?.message || '').slice(0,160) })
})
ipcMain.on('mp:lyrics:resize-start', (event, point) => {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || event.sender !== lyricsWindow.webContents || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  const bounds = lyricsWindow.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const maxWidth = Math.min(area.width, area.height * LYRICS_RATIO)
  const width = Math.max(1, Math.min(bounds.width, maxWidth))
  const height = Math.round(width / LYRICS_RATIO)
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))
  const normalized = { x:Math.round(x), y:Math.round(y), width:Math.round(width), height }
  if (bounds.x !== normalized.x || bounds.y !== normalized.y || bounds.width !== normalized.width || bounds.height !== normalized.height) setLyricsBounds(lyricsWindow, normalized)
  lyricsResize = { x:point.x, y:point.y, bounds:normalized, area }
})
ipcMain.on('mp:lyrics:resize', (event, point) => {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || event.sender !== lyricsWindow.webContents) return
  if (!lyricsResize || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  const { bounds, area } = lyricsResize
  const dx = point.x - lyricsResize.x, dy = point.y - lyricsResize.y
  const factor = screen.getDisplayMatching(bounds).scaleFactor || 1
  const change = (dx + dy / LYRICS_RATIO) / (1 + 1 / LYRICS_RATIO ** 2) / factor
  const maxWidth = Math.min(area.x + area.width - bounds.x, (area.y + area.height - bounds.y) * LYRICS_RATIO)
  const width = Math.round(Math.max(Math.min(320, maxWidth), Math.min(maxWidth, bounds.width + change)))
  setLyricsBounds(lyricsWindow, { x:bounds.x, y:bounds.y, width, height:Math.round(width / LYRICS_RATIO) })
})
ipcMain.on('mp:lyrics:resize-end', event => { if (lyricsWindow && !lyricsWindow.isDestroyed() && event.sender === lyricsWindow.webContents) lyricsResize = null })
ipcMain.on('mp:lyrics:reset-bounds', (event) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return
  lyricsBounds = null
  if (lyricsWindow && !lyricsWindow.isDestroyed()) setLyricsBounds(lyricsWindow, defaultLyricsBounds())
})
ipcMain.handle('mp:lyrics:is-open', (event) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false
  return Boolean(lyricsWindow && !lyricsWindow.isDestroyed())
})

/* ---------- window controls ---------- */
ipcMain.on('mp:window', (_event, action) => {
  if (!win) return
  if (action === 'minimize') win.minimize()
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  else if (action === 'close') win.close()
})
ipcMain.handle('mp:window:isMaximized', () => (win ? win.isMaximized() : false))
ipcMain.handle('mp:window:close-preference:get', () => readClosePreference())
ipcMain.handle('mp:window:close-preference:set', (_event, action) => writeClosePreference(action))
ipcMain.handle('mp:app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  dev: isDev
}))
ipcMain.on('mp:chat:instant-ready', event => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return
  instantChatRendererReady = true
  deliverInstantChatNavigation()
})
ipcMain.on('mp:chat:instant-ack', (event, sequence) => {
  if (win && !win.isDestroyed() && event.sender === win.webContents && sequence === pendingInstantChat) pendingInstantChat = 0
})
ipcMain.on('mp:chat:notify', (event, data) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !Notification.isSupported()) return
  const user = String(data?.user || '成员').replace(/[\r\n\t]+/g, ' ').slice(0, 60)
  const value = String(data?.text || '').replace(/[\r\n\t]+/g, ' ').trim()
  const graphemes = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)].map(x=>x.segment) : Array.from(value)
  const trimmed = graphemes.length > 36 ? [...graphemes.slice(0, 35), '…'] : graphemes
  const body = [trimmed.slice(0,18).join(''), trimmed.slice(18).join('')].filter(Boolean).join('\n')
  try {
    const notification = new Notification({ title:`${user} 发送了一条消息：`, body, silent:false, icon:appIconPath() })
    notification.on('click', () => {
      pendingInstantChat = ++instantChatSequence
      showMainWindow()
      deliverInstantChatNavigation()
    })
    notification.show()
  } catch (error) { console.warn('[chat] notification failed:', error.message) }
})

/* ---------- close-to-tray IPC ----------
   渲染层可主动发起/回答关闭询问；真正关闭仍由 win.on('close') + 原生兜底 dialog 把关，
   自动化模式（MP_SHOT/MP_EVAL）不拦截关闭，保证截图/评测进程能退出。 */
ipcMain.on('mp:window:request-close', (event) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return
  requestCloseDecision()
})
ipcMain.on('mp:window:close-response', (event, payload) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return
  resolveCloseResponse(payload)
})

/* ---------- CORS-free HTTP bridge ----------
   REST endpoints of the Music Party backend are same-origin only (no CORS config),
   while the renderer runs from file:// or the Vite dev server. The main process
   fetches on behalf of the renderer so search/lyrics/auth keep working.

   安全语义（D-08/D-03）：只允许受信渲染来源（file:// 或本地 dev server）调用；
   绝不跟随重定向（3xx → redirect-blocked + location/crossOrigin），避免
   X-Admin-Password / X-Room-Token 等敏感头随跳转泄漏。实现见 http-bridge.cjs。 */
ipcMain.handle('mp:http:request', createHttpBridgeHandler())

/* ---------- app lifecycle ---------- */
// Screenshot/eval runs may happen in parallel with the live app; skip the lock then.
const gotLock = isShot || hasEval ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  // 退出流程：放行 close 拦截 + 销毁托盘（launcher 自己的 before-quit 会停本地服务）。
  app.on('before-quit', () => {
    allowClose = true
    if (pendingCloseRequest) {
      clearTimeout(pendingCloseRequest.timer)
      pendingCloseRequest = null
    }
  })
  app.on('will-quit', () => {
    try { if (trayController) trayController.destroy() } catch { /* ignore */ }
  })

  app.whenReady().then(async () => {
    createWindow()
    // safeStorage 用于加密启动器秘密（D-03）；必须在 app ready 之后才可用。
    launcherController = registerLauncher({ ipcMain, app, getWindow: () => win, safeStorage, onQuitFailed: (message) => {
      allowClose = false
      showMainWindow()
      dialog.showErrorBox('无法退出 Music Party', message)
    } })
    try {
      trayController = await registerTray({
        app,
        ipcMain,
        Tray,
        Menu,
        BrowserWindow,
        nativeImage,
        screen,
        shell,
        getMainWindow: () => win,
        isDev,
        isAutomated,
        showMainWindow,
        quitApp: quitNow,
        iconPath: appIconPath(),
        distIndex: path.join(__dirname, '..', 'dist', 'index.html'),
        devServerUrl: 'http://localhost:5173'
      })
    } catch (error) {
      console.warn('[tray] 初始化失败，降级为无托盘模式（关闭询问只提供关闭/取消）', error)
      trayController = null
    }
    // dev 手动验证：MP_TRAY_OPEN=1 时启动后自动弹出状态卡（不参与自动化门禁）。
    if (!isAutomated && process.env.MP_TRAY_OPEN === '1' && trayController) {
      setTimeout(async () => {
        try {
          trayController.showCard()
          if (process.env.MP_TRAY_DUMP === '1') {
            setTimeout(async () => {
              try {
                const snapshot = await trayController.readCardSnapshot()
                console.log(`[tray-e2e] card snapshot ${JSON.stringify(snapshot)}`)
              } catch (error) {
                console.warn('[tray-e2e] read card snapshot failed', error)
              }
              allowClose = true
              app.quit()
            }, 2500)
          }
        } catch (error) {
          console.warn('[tray] MP_TRAY_OPEN 展示失败', error)
        }
      }, 1500)
    }
    app.on('activate', () => {
      if (!win || win.isDestroyed()) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

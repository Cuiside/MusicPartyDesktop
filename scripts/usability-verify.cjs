'use strict'
/**
 * Public-release usability audit · one-shot PASS/FAIL battery (new public build).
 *
 * Covers the user complaints end to end:
 *   1. first launch goes to the onboarding/join page (never demo silently), demo is an
 *      explicit opt-in and can be left again;
 *   2. default nickname is 游客;
 *   3. P0 privacy: no real personal domain / IP / password / cookie / developer absolute
 *      path in the shipped client (src + dist) — note: the label「我的房间」is allowed by
 *      the 2026-11-09 product ruling, but it must resolve to a local/user-saved address;
 *   4. local-service missing is explained neutrally in the public build, with an advanced
 *      layer + file pickers for users who do run their own server;
 *   5. admin surfaces (admin auth dialog, admin terminal, locked console) need real auth;
 *   6. 1024/1440 have no horizontal scroll/clipping, 1920 upsizes (innerWidth 1440–1600);
 *   7. wrong password / unreachable server / non-MusicParty address errors are understandable;
 *   + keyboard CTRL K / CTRL , / ESC.
 *
 * Usage:
 *   node scripts/usability-verify.cjs --tag final
 *   node scripts/usability-verify.cjs --tag final --repo E:\some\build
 *   node scripts/usability-verify.cjs --only static,first-launch,my-room,admin,service,errors
 *
 * Evidence: screenshots/usability/<tag>/_eval/verify-<stamp>.{json,log}
 * Exactly one Electron instance runs at a time.
 */

const fs = require('node:fs')
const path = require('node:path')
const {
  repoRoot,
  outRoot,
  stamp,
  ensureDir,
  gitInfo,
  runEval,
  withGenuineApp,
  startWrongPasswordServer,
  startHtmlServer
} = require('./usability-lib.cjs')

function arg(name, fallback = '') {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const repo = path.resolve(arg('repo', process.env.MP_USABILITY_REPO || repoRoot()))
const tag = arg('tag', process.env.MP_USABILITY_TAG || 'run-' + stamp())
const outDir = ensureDir(path.resolve(arg('out', path.join(outRoot(), tag))))
const evalDir = ensureDir(path.join(outDir, '_eval'))
const only = (() => {
  const raw = arg('only', '')
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null
})()
const logStem = `verify-${stamp()}`
const logFile = path.join(evalDir, `${logStem}.log`)
const jsonFile = path.join(evalDir, `${logStem}.json`)

const LOG = []
const ROWS = []

function log(line) {
  const text = String(line)
  LOG.push(text)
  console.log(text)
}

function want(group) {
  if (!only) return true
  for (const key of only) if (group === key || group.startsWith(key + '-') || key.startsWith(group)) return true
  return false
}

function record(row) {
  ROWS.push(row)
  log(`[verify] ${row.pass ? 'PASS' : 'FAIL'} ${row.severity} ${row.id} — ${row.title}`)
  for (const ev of row.evidence || []) log(`[verify]        · ${ev}`)
  return row
}
const pass = (id, severity, title, evidence) => record({ id, severity, title, pass: true, evidence })
const fail = (id, severity, title, evidence) => record({ id, severity, title, pass: false, evidence })

/* ================================================================== */
/* 1. static scan (privacy / personal data / hardcoded values)         */
/* ================================================================== */

const TEXT_EXT = new Set(['.js', '.cjs', '.mjs', '.vue', '.css', '.html', '.json'])

function walk(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}
const rel = (file) => path.relative(repo, file).replace(/\\/g, '/')
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}
const contextOf = (text, index, length = 100) =>
  text
    .slice(Math.max(0, index - 40), Math.min(text.length, index + length))
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Personal data that must never ship. Real tokens are allowed inside scripts/ (they are
 * the scan pattern itself, not the client); they must never appear in src/electron/dist.
 */
const PERSONAL_PATTERNS = [
  { severity: 'P0', label: '真实个人服务器域名', re: /music\.cqszzx\.cn/i },
  { severity: 'P0', label: '真实个人服务器 IP', re: /82\.157\.124\.63/ },
  { severity: 'P0', label: '真实个人标识 room-fixture', re: /\bxmr\b/i },
  { severity: 'P0', label: '开发机绝对路径', re: /[A-Z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+\\{1,2}/i },
  { severity: 'P0', label: '真实 Cookie（SESSDATA/MUSIC_U/__csrf）', re: /(SESSDATA|MUSIC_U|__csrf|MUSIC_A)\s*[=:]\s*[A-Za-z0-9%._-]{16,}/ }
]

const RUNTIME_PATTERNS = [
  { severity: 'P1', label: '硬编码默认管理员密码 admin123', re: /\badmin123\b/ },
  { severity: 'P2', label: '硬编码演示房间码 MP-FMA204', re: /MP-FMA204/ }
]

const DOC_PATTERNS = [
  { severity: 'P2', label: '文档泄漏个人服务器/路径/密码', re: /music\.cqszzx\.cn|82\.157\.124\.63|[A-Z]:\\{1,2}Users\\{1,2}|\badmin123\b/i }
]

function scanPatterns(roots, patterns) {
  const files = []
  for (const root of roots) {
    const full = path.join(repo, root)
    if (!fs.existsSync(full)) continue
    if (fs.statSync(full).isFile()) files.push(full)
    else walk(full, files)
  }
  const hits = []
  for (const file of files) {
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const pattern of patterns) {
      const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g')
      let match
      let guard = 0
      while ((match = re.exec(text)) !== null && guard < 12) {
        guard += 1
        hits.push({ severity: pattern.severity, label: pattern.label, file: rel(file), line: lineOf(text, match.index), context: contextOf(text, match.index) })
      }
    }
  }
  return hits
}

function staticScan() {
  const runtimeHits = scanPatterns(['src', 'electron', 'index.html', 'package.json'], PERSONAL_PATTERNS)
  const distHits = fs.existsSync(path.join(repo, 'dist')) ? scanPatterns(['dist'], PERSONAL_PATTERNS) : []
  const secretHits = scanPatterns(['src', 'electron', 'dist'], RUNTIME_PATTERNS)
  const docHits = scanPatterns(['docs'], DOC_PATTERNS)
  const mineNaming = scanPatterns(['src'], [{ severity: 'P3', label: '「我的房间」命名（允许，仅记录）', re: /我的房间/ }])
  const devPathHits = scanPatterns(['electron'], [{ severity: 'P0', label: '开发机回退 jar / 绝对路径', re: /DEV_JAR_FALLBACK|[A-Z]:\\{1,2}Users\\{1,2}/i }])

  const fmt = (hit) => `${hit.file}:${hit.line} [${hit.label}] "${hit.context}"`
  const p0 = [...runtimeHits, ...distHits].filter((h) => h.severity === 'P0')
  p0.length === 0
    ? pass('static-personal-data', 'P0', '客户端（src/electron/dist）不含真实个人域名/IP/密码/Cookie/开发机绝对路径', [
        `扫描范围: src, electron, index.html, package.json, dist（命中 ${runtimeHits.length + distHits.length}，P0=0）`
      ])
    : fail('static-personal-data', 'P0', '客户端（src/electron/dist）不含真实个人域名/IP/密码/Cookie/开发机绝对路径', p0.map(fmt))

  const personal = [...runtimeHits, ...distHits]
  if (personal.length === 0) {
    pass('static-personal-data-detail', 'P0', '无真实 Cookie / 个人域名 / 个人 IP / 开发机路径残留', ['P0 模式扫描 0 命中'])
  } else {
    fail('static-personal-data-detail', 'P0', '无真实 Cookie / 个人域名 / 个人 IP / 开发机路径残留', personal.map(fmt))
  }

  const p1Secrets = secretHits.filter((h) => h.severity === 'P1')
  p1Secrets.length === 0
    ? pass('static-hardcoded-secrets', 'P1', '运行时代码/产物不含硬编码默认管理员密码', ['admin123 0 命中'])
    : fail('static-hardcoded-secrets', 'P1', '运行时代码/产物不含硬编码默认管理员密码', p1Secrets.map(fmt))

  const p2Demo = secretHits.filter((h) => h.severity === 'P2')
  p2Demo.length === 0
    ? pass('static-demo-roomcode', 'P2', '演示房间码不出现在可复制 token 代码路径', ['MP-FMA204 0 命中'])
    : fail('static-demo-roomcode', 'P2', '演示房间码出现在代码中（仅影响演示，不应拼进可复制 token）', p2Demo.map(fmt))

  if (devPathHits.length === 0) {
    pass('service-no-dev-path', 'P0', '启动器不含开发机回退 jar 绝对路径', ['electron/**/*.cjs 0 命中 DEV_JAR_FALLBACK / 开发机绝对路径'])
  } else {
    fail('service-no-dev-path', 'P0', '启动器不含开发机回退 jar 绝对路径', devPathHits.map(fmt))
  }

  docHits.length === 0
    ? pass('static-docs-leak', 'P2', '仓库文档不含个人服务器/路径/密码', ['docs/** 0 命中'])
    : fail('static-docs-leak', 'P2', '仓库文档含个人服务器/路径/密码（不进安装包，但公开仓库会泄漏）', docHits.map(fmt))

  log(`[verify] info: 「我的房间」命名 ${mineNaming.length} 处（2026-11-09 用户裁决：允许，改为功能断言）`)

  // File picker plumbing for the advanced local-service config.
  let pickerStatic = null
  try {
    const preload = fs.readFileSync(path.join(repo, 'electron', 'preload.cjs'), 'utf8')
    const launcher = fs.readFileSync(path.join(repo, 'electron', 'launcher.cjs'), 'utf8')
    pickerStatic = {
      preloadPickFile: /launcher:pickFile/.test(preload),
      launcherShowOpenDialog: /showOpenDialog/.test(launcher),
      pickFileHandler: /pickFile/.test(launcher)
    }
  } catch (error) {
    pickerStatic = { error: String(error) }
  }
  pickerStatic.preloadPickFile && pickerStatic.launcherShowOpenDialog
    ? pass('service-file-picker-plumbing', 'P1', '文件选择 IPC 已接通（preload pickFile + 主进程 showOpenDialog）', [JSON.stringify(pickerStatic)])
    : fail('service-file-picker-plumbing', 'P1', '文件选择 IPC 已接通（preload pickFile + 主进程 showOpenDialog）', [JSON.stringify(pickerStatic)])

  return { runtimeHits, distHits, secretHits, docHits, mineNamingCount: mineNaming.length, pickerStatic }
}

/* ================================================================== */
/* 2. renderer probes                                                  */
/* ================================================================== */

const LAYOUT_PROBE = `(() => {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const doc = document.documentElement
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const overflow = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue
    if (r.right > vw + 1.5 || r.left < -1.5) {
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : el.tagName
      overflow.push(cls + ' ' + Math.round(r.left) + '..' + Math.round(r.right))
    }
  }
  const keys = {}
  for (const sel of ['.window-frame', '.mp-body', '.navrail', '.sidebar', '.mp-main', '.command-bar', '.mp-workspace-row', '.statusbar', '.settings', '.console-grid', '.onboarding']) keys[sel] = rect(sel)
  const clipped = []
  for (const el of document.querySelectorAll('.mp-main, .mp-workspace-row, .workspace-inner, .settings, .console-grid, .onboarding, .onb-card')) {
    const r = el.getBoundingClientRect()
    if (r.width > 2 && r.right > vw + 2) clipped.push((el.className || el.tagName) + ' right=' + Math.round(r.right))
  }
  return { innerWidth: vw, innerHeight: vh, docScrollWidth: doc.scrollWidth, docClientWidth: doc.clientWidth, overflowX: Math.max(0, doc.scrollWidth - doc.clientWidth), overflowCount: overflow.length, overflow: overflow.slice(0, 12), keys, clipped }
})()`

const ZOOM_PROBE = `(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio }))()`

const NICKNAME_DIALOG_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const dialog = document.querySelector('.join-dialog')
  const name = dialog ? dialog.querySelector('#join-dialog-name, input[placeholder*="昵称"], .join-row input') : null
  let server = dialog ? dialog.querySelector('#join-dialog-server') : null
  const password = dialog ? dialog.querySelector('#join-dialog-password, input[type=password]') : null
  const out = {
    dialog: !!dialog,
    nickname: name ? name.value : null,
    server: server ? server.value : '',
    advancedVisible: !!document.querySelector('#join-dialog-advanced'),
    serverHost: '',
    passwordValue: password ? password.value : null,
    dialogText: dialog ? dialog.textContent.replace(/\\s+/g, ' ').trim().slice(0, 600) : ''
  }
  if (dialog && !server) {
    const adv = dialog.querySelector('.onb-server-row')
    if (adv) { adv.click(); await sleep(350) }
    server = dialog.querySelector('#join-dialog-server')
    out.advancedVisible = !!document.querySelector('#join-dialog-advanced')
    out.server = server ? server.value : ''
  }
  const hostEl = document.querySelector('#join-dialog-advanced .onb-server-value, #join-dialog-advanced .join-server-value, .join-dialog .onb-server-value')
  out.serverHost = hostEl ? hostEl.textContent.replace(/\\s+/g, ' ').trim() : ''
  return out
})()`

/** Click the account menu → 管理员认证, then open the console in the demo shell. */
const ADMIN_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const out = { adminPageBefore: !!document.querySelector('.admin-page') }
  const trigger = document.querySelector('.nav-account')
  if (trigger) trigger.click()
  await sleep(400)
  const menu = document.querySelector('.ctxmenu')
  out.items = menu ? [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()) : []
  const adminItem = menu ? [...menu.querySelectorAll('.ctx-item')].find((b) => /管理员/.test(b.textContent || '')) : null
  out.adminClicked = adminItem ? adminItem.textContent.trim() : null
  if (adminItem) adminItem.click()
  await sleep(700)
  const dialog = document.querySelector('.admin-auth-dialog')
  out.authDialog = !!dialog
  out.authText = txt(dialog).slice(0, 700)
  out.authPasswordInput = !!document.querySelector('#admin-auth-password')
  out.adminPageAfter = !!document.querySelector('.admin-page')
  const close = document.querySelector('.admin-auth-close')
  if (close) close.click()
  await sleep(350)
  const navs = [...document.querySelectorAll('.nav-item')]
  out.navLabels = navs.map((b) => (b.textContent || '').trim() || b.title)
  const consoleBtn = navs.find((b) => /控制台/.test((b.textContent || '') + (b.title || '')))
  if (consoleBtn) consoleBtn.click()
  await sleep(700)
  out.consoleVisible = !!document.querySelector('.console-grid')
  out.consoleSvcNote = txt(document.querySelector('.svc-note')).slice(0, 500)
  out.consoleText = txt(document.querySelector('.console-grid')).slice(0, 900)
  out.demoLabel = /演示模式/.test(document.body.innerText)
  return out
})()`

/** Settings → 服务与连接 (neutral copy + advanced layer + pickers), then console service note. */
const SERVICE_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const out = {}
  const navs = [...document.querySelectorAll('.settings-nav-item')]
  out.navLabels = navs.map((b) => b.textContent.replace(/\\s+/g, ' ').trim())
  const target = navs.find((b) => /服务/.test(b.textContent || ''))
  if (target) target.click()
  await sleep(600)
  out.cardTitle = txt(document.querySelector('.svc-card-title'))
  out.cardDesc = txt(document.querySelector('.svc-card-desc'))
  out.svcHints = [...document.querySelectorAll('.svc-hint')].map(txt).filter(Boolean)
  out.advToggle = txt(document.querySelector('.svc-adv-toggle'))
  out.advBefore = !!document.querySelector('.svc-adv')
  out.contentTextBefore = txt(document.querySelector('.settings-content')).slice(0, 2200)
  const adv = document.querySelector('.svc-adv-toggle')
  if (adv) adv.click()
  await sleep(450)
  out.advAfter = !!document.querySelector('.svc-adv')
  out.advText = txt(document.querySelector('.svc-adv')).slice(0, 1400)
  out.advButtons = [...document.querySelectorAll('.svc-adv button, .svc-guide-actions button, .svc-card-actions button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean)
  out.chooseButtons = [...document.querySelectorAll('.settings button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).filter((t) => /选择|浏览/.test(t))
  out.fileInputs = document.querySelectorAll('.settings input[type=file]').length
  out.contentTextAfter = txt(document.querySelector('.settings-content')).slice(0, 2600)
  const back = [...document.querySelectorAll('.settings button')].find((b) => /返回应用/.test(b.textContent || ''))
  if (back) back.click()
  await sleep(500)
  const navItems = [...document.querySelectorAll('.nav-item')]
  const consoleBtn = navItems.find((b) => /控制台/.test((b.textContent || '') + (b.title || '')))
  if (consoleBtn) consoleBtn.click()
  await sleep(700)
  out.consoleSvcNote = txt(document.querySelector('.svc-note')).slice(0, 600)
  out.consoleFailure = !!document.querySelector('.svc-fail')
  out.consoleStartDisabled = (() => {
    const btn = [...document.querySelectorAll('.console-grid button')].find((b) => /启动/.test(b.textContent || ''))
    return btn ? btn.disabled : null
  })()
  out.consoleText = txt(document.querySelector('.console-grid')).slice(0, 1200)
  return out
})()`

const KEYBOARD_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const send = (key, opts) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, opts || {})))
  const palette = () => document.querySelector('.palette, .command-palette')
  const settings = () => document.querySelector('.settings')
  send('k', { ctrlKey: true })
  await sleep(450)
  const opened = !!palette()
  send('Escape')
  await sleep(350)
  const closed = !palette()
  send(',', { ctrlKey: true })
  await sleep(500)
  const settingsOpened = !!settings()
  send('Escape')
  await sleep(350)
  const settingsClosed = !settings()
  return { opened, closed, settingsOpened, settingsClosed }
})()`

/* ---- genuine first launch (CDP) ---- */

const FIRST_LAUNCH_PROBE = `(() => {
  const txt = (sel) => {
    const el = document.querySelector(sel)
    return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''
  }
  return {
    url: location.href,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    onboarding: !!document.querySelector('#onboarding, .onboarding'),
    onboardingText: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 900),
    nickname: (document.querySelector('#onb-nickname') || {}).value || null,
    privacyText: txt('.onb-privacy'),
    demoButton: !!document.querySelector('#onb-demo'),
    demoWorkspaceVisible: !!document.querySelector('.mp-workspace-row'),
    demoBannerVisible: !!document.querySelector('.demo-banner'),
    mineHost: txt('.onb-room-host'),
    mineTag: txt('.onb-room-tag'),
    joinTab: !!document.querySelector('#onb-tab-join'),
    mineTab: !!document.querySelector('#onb-tab-mine'),
    localStorageMine: (() => { try { return localStorage.getItem('mp.room.mine.v1') } catch { return 'ERR' } })()
  }
})()`

const MY_ROOM_FLOW = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const out = { steps: [] }
  out.pageHasPersonalLeak = /music\\.cqszzx\\.cn|82\\.157\\.124\\.63|\\bxmr\\b/i.test(document.body.innerText)
  out.localOnlyCopy = /仅保存在本机|只保存在本机|只保存在这台电脑/.test(document.body.innerText)
  out.privacyText = txt(document.querySelector('.onb-privacy'))
  // Default state must be the local「我的房间」target, never a hardcoded public server.
  out.defaultModeMine = /我的房间/.test(txt(document.querySelector('#onb-tab-mine'))) && !/join/.test(String((document.querySelector('#onb-tab-mine') || {}).className || 'join'))
  out.mineHost = txt(document.querySelector('.onb-room-host'))
  out.mineTag = txt(document.querySelector('.onb-room-tag'))
  out.mineSubmitText = txt(document.querySelector('#onb-submit-mine'))
  out.mineServerValue = (document.querySelector('#onb-mine-server') || {}).value || ''
  // Switch to「加入房间」and verify a friend/remote address can be entered.
  const joinTab = document.querySelector('#onb-tab-join')
  if (joinTab) { joinTab.click(); out.steps.push('click-join-tab') }
  await sleep(400)
  let input = document.querySelector('#onb-join-server')
  if (!input) {
    const adv = document.querySelector('.onb-server-row')
    if (adv) { adv.click(); out.steps.push('open-advanced') }
    await sleep(400)
    input = document.querySelector('#onb-join-server')
  }
  out.joinInputPresent = !!input
  out.joinAdvancedVisible = !!document.querySelector('#onb-join-advanced')
  if (input) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    desc.set.call(input, 'https://friend-room.example.com')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    out.steps.push('fill-remote')
  }
  await sleep(300)
  out.joinInputValue = (document.querySelector('#onb-join-server') || {}).value || ''
  out.joinTargetHost = txt(document.querySelector('.onb-server-value'))
  out.joinHint = txt(document.querySelector('.onb-join-hint'))
  out.advancedHint = txt(document.querySelector('.onb-advanced-hint'))
  out.joinSubmitText = txt(document.querySelector('#onb-submit-join'))
  // Back to「我的房间」: target must still be the local/saved address, not the remote one.
  const mineTab = document.querySelector('#onb-tab-mine')
  if (mineTab) { mineTab.click(); out.steps.push('click-mine-tab') }
  await sleep(400)
  out.mineHostAfterRemote = txt(document.querySelector('.onb-room-host'))
  out.mineTagAfterRemote = txt(document.querySelector('.onb-room-tag'))
  out.localStorageMine = (() => { try { return localStorage.getItem('mp.room.mine.v1') } catch { return 'ERR' } })()
  return out
})()`

const DEMO_FLOW = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const out = {}
  out.onboardingBefore = !!document.querySelector('#onboarding, .onboarding')
  const demoBtn = document.querySelector('#onb-demo')
  if (demoBtn) demoBtn.click()
  await sleep(1000)
  out.onboardingAfter = !!document.querySelector('#onboarding, .onboarding')
  out.demoBanner = !!document.querySelector('.demo-banner')
  out.demoBannerText = txt(document.querySelector('.demo-banner'))
  out.workspace = !!document.querySelector('.mp-workspace-row')
  const skip = [...document.querySelectorAll('.tutorial button')].find((b) => /跳过/.test(b.textContent || ''))
  out.tutorialSkipped = !!skip
  if (skip) { skip.click(); await sleep(350) }
  const back = document.querySelector('.demo-banner-return')
  out.returnCta = back ? txt(back) : ''
  if (back) back.click()
  await sleep(900)
  out.onboardingAfterReturn = !!document.querySelector('#onboarding, .onboarding')
  out.demoBannerAfterReturn = !!document.querySelector('.demo-banner')
  out.tutorialAfterReturn = !!document.querySelector('.tutorial')
  return out
})()`

function onboardingNetProbe(url, options = {}) {
  const target = JSON.stringify(String(url || ''))
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const out = { probeClicked: false, submitClicked: false }
  const joinTab = document.querySelector('#onb-tab-join')
  if (joinTab) joinTab.click()
  await sleep(400)
  let input = document.querySelector('#onb-join-server')
  if (!input) {
    const adv = document.querySelector('.onb-server-row')
    if (adv) adv.click()
    await sleep(400)
    input = document.querySelector('#onb-join-server')
  }
  out.inputPresent = !!input
  if (input) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    desc.set.call(input, ${target})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const password = document.querySelector('#onb-password')
  if (${options.submit === true} && password) {
    const desc2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    desc2.set.call(password, 'wrong-password-123')
    password.dispatchEvent(new Event('input', { bubbles: true }))
    out.passwordFilled = true
  }
  await sleep(250)
  const check = [...document.querySelectorAll('.onb-check')].find((b) => b.getBoundingClientRect().width > 2)
  if (${options.probe === true} && check) { check.click(); out.probeClicked = true }
  if (${options.submit === true}) {
    const submit = document.querySelector('#onb-submit-join')
    if (submit) { submit.click(); out.submitClicked = true }
  }
  const started = Date.now()
  let probeText = ''
  let probeClass = ''
  let errorText = ''
  while (Date.now() - started < ${Number(options.maxMs || 14000)}) {
    const p = document.querySelector('.onb-probe-result')
    probeText = txt(p)
    probeClass = p ? String(p.className) : ''
    errorText = txt(document.querySelector('#onb-error')) || txt(document.querySelector('.onb-error'))
    if (${options.probe === true} && /fail|ok/.test(probeClass)) break
    if (${options.submit === true} && errorText) break
    await sleep(200)
  }
  out.ms = Date.now() - started
  out.probeText = probeText
  out.probeClass = probeClass
  out.errorText = errorText
  out.errorVisible = !!document.querySelector('#onb-error, .onb-error')
  out.joining = !!document.querySelector('#onb-submit-join[disabled]')
  return out
})()`
}

/* ================================================================== */
/* 3. checks                                                           */
/* ================================================================== */

async function runFirstLaunch() {
  log('')
  log('[verify] ===== 真实首启（无 shot/eval query）=====')
  const res = await withGenuineApp({
    repo,
    width: 1440,
    height: 900,
    run: async ({ eval: evalInPage }) => ({
      launch: await evalInPage(FIRST_LAUNCH_PROBE, 20000),
      myroom: await evalInPage(MY_ROOM_FLOW, 30000)
    })
  })
  if (!res.ok) {
    fail('first-launch-guided', 'P0', '首次打开进入加入/引导页，而不是默认演示模式', [`CDP 启动失败: ${res.error}`])
    fail('default-nickname', 'P0', '默认昵称 = 游客', ['无法读取昵称'])
    fail('my-room-local-target', 'P0', '「我的房间」目标必须是本机/用户已保存地址，不得是写死的公网服务器', ['无法执行交互探针'])
    return
  }
  const l = res.result.launch
  const m = res.result.myroom
  const launchEv = [
    `url=${l.url}`,
    `onboarding=${l.onboarding} demoWorkspace=${l.demoWorkspaceVisible} demoBanner=${l.demoBannerVisible}`,
    `nickname=${JSON.stringify(l.nickname)}`,
    `privacy="${l.privacyText}"`,
    `mineHost=${JSON.stringify(l.mineHost)} mineTag=${JSON.stringify(l.mineTag)}`,
    `localStorage.mp.room.mine.v1=${JSON.stringify(l.localStorageMine)}`
  ]
  l.onboarding && !l.demoWorkspaceVisible
    ? pass('first-launch-guided', 'P0', '首次打开进入加入/引导页，而不是默认演示模式', launchEv)
    : fail('first-launch-guided', 'P0', '首次打开进入加入/引导页，而不是默认演示模式', [...launchEv, '未进入独立 onboarding 页或首启即渲染演示工作区'])
  l.nickname === '游客'
    ? pass('default-nickname', 'P0', '默认昵称 = 游客', launchEv)
    : fail('default-nickname', 'P0', '默认昵称 = 游客', [...launchEv, `实际=${JSON.stringify(l.nickname)}`])

  const hostOf = (raw) => {
    try {
      const text = String(raw || '').trim()
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname
    } catch {
      return ''
    }
  }
  const localHosts = ['localhost', '127.0.0.1', '::1', '[::1]']
  const mineHostName = hostOf(m.mineHost || l.mineHost)
  const mineLocal = localHosts.includes(mineHostName) || /本机/.test(m.mineTag || l.mineTag || '')
  const mineEv = [
    `defaultModeMine=${m.defaultModeMine}`,
    `mineHost=${JSON.stringify(m.mineHost || l.mineHost)} mineTag=${JSON.stringify(m.mineTag || l.mineTag)}`,
    `mineHostAfterRemote=${JSON.stringify(m.mineHostAfterRemote)} mineTagAfterRemote=${JSON.stringify(m.mineTagAfterRemote)}`,
    `localStorage.mp.room.mine.v1=${JSON.stringify(m.localStorageMine)}`,
    `pageHasPersonalLeak=${m.pageHasPersonalLeak}`,
    `localOnlyCopy=${m.localOnlyCopy} privacy="${m.privacyText}"`
  ]
  m.defaultModeMine && mineLocal && m.pageHasPersonalLeak === false && m.localOnlyCopy
    ? pass('my-room-local-target', 'P0', '「我的房间」目标为 127.0.0.1/localhost 或用户已保存地址，且地址仅保存在本机', mineEv)
    : fail('my-room-local-target', 'P0', '「我的房间」目标为 127.0.0.1/localhost 或用户已保存地址，且地址仅保存在本机', mineEv)

  const joinEv = [
    `joinInputPresent=${m.joinInputPresent} advancedVisible=${m.joinAdvancedVisible}`,
    `joinInputValue=${JSON.stringify(m.joinInputValue)} targetHost=${JSON.stringify(m.joinTargetHost)}`,
    `joinHint="${m.joinHint}" advancedHint="${m.advancedHint}"`,
    `steps=${JSON.stringify(m.steps)}`
  ]
  m.joinInputPresent && /friend-room\.example\.com/.test(m.joinInputValue || '') && /friend-room\.example\.com/.test(m.joinTargetHost || '')
    ? pass('join-room-remote-address', 'P1', '「加入房间」可填写朋友的远程/邀请地址，且未改写「我的房间」', joinEv)
    : fail('join-room-remote-address', 'P1', '「加入房间」可填写朋友的远程/邀请地址，且未改写「我的房间」', joinEv)

  log('')
  log('[verify] ===== 演示模式：显式进入 + 可返回 =====')
  const flow = await withGenuineApp({ repo, width: 1440, height: 900, run: ({ eval: evalInPage }) => evalInPage(DEMO_FLOW, 30000) })
  if (!flow.ok) {
    fail('demo-explicit-return', 'P1', '演示模式仅显式进入且可返回', [`CDP 启动失败: ${flow.error}`])
    return
  }
  const f = flow.result
  const flowEv = [
    `onboardingBefore=${f.onboardingBefore} afterDemoEntry=${f.onboardingAfter}`,
    `demoBanner=${f.demoBanner} "${f.demoBannerText}"`,
    `workspace=${f.workspace}`,
    `returnCta=${JSON.stringify(f.returnCta)}`,
    `onboardingAfterReturn=${f.onboardingAfterReturn} demoBannerAfterReturn=${f.demoBannerAfterReturn}`
  ]
  f.onboardingBefore && !f.onboardingAfter && f.demoBanner && f.workspace && f.returnCta && f.onboardingAfterReturn && !f.demoBannerAfterReturn
    ? pass('demo-explicit-return', 'P1', '演示模式仅显式进入且可返回', flowEv)
    : fail('demo-explicit-return', 'P1', '演示模式仅显式进入且可返回', flowEv)
  ;(f.demoBanner && /演示/.test(f.demoBannerText || '') ? pass : fail)('demo-mode-labelled', 'P2', '演示模式有明确的「演示数据」标识', [`banner="${f.demoBannerText}"`])
}

async function runNicknameDialog() {
  log('')
  log('[verify] ===== 加入弹窗默认值 =====')
  const res = await runEval({ repo, extra: 'join=1', wait: 1400, code: NICKNAME_DIALOG_PROBE, width: 1440, height: 900 })
  const r = res.result
  if (!r) return fail('join-dialog-defaults', 'P1', '加入弹窗默认昵称=游客、密码留空、无个人服务器预填', ['无 eval 结果'])
  const localish = /127\.0\.0\.1|localhost|your-server/.test([r.server, r.serverHost, r.dialogText].join(' '))
  r.dialog && r.nickname === '游客' && (!r.passwordValue || r.passwordValue === '') && localish
    ? pass('join-dialog-defaults', 'P1', '加入弹窗默认昵称=游客、密码留空、无个人服务器预填', [
        `nickname=${JSON.stringify(r.nickname)} server=${JSON.stringify(r.server)} serverHost=${JSON.stringify(r.serverHost)} password=empty advanced=${r.advancedVisible}`
      ])
    : fail('join-dialog-defaults', 'P1', '加入弹窗默认昵称=游客、密码留空、无个人服务器预填', [
        `dialog=${r.dialog} nickname=${JSON.stringify(r.nickname)} server=${JSON.stringify(r.server)} serverHost=${JSON.stringify(r.serverHost)} password=${JSON.stringify(r.passwordValue)}`
      ])
}

async function runLayout() {
  log('')
  log('[verify] ===== 布局：1024 / 1440 无横向滚动、无裁剪 =====')
  const cases = [
    { width: 1024, height: 768, view: '' },
    { width: 1440, height: 900, view: '' },
    { width: 1024, height: 768, view: 'settings' },
    { width: 1440, height: 900, view: 'settings' },
    { width: 1024, height: 768, view: 'console' },
    { width: 1440, height: 900, view: 'console' }
  ]
  for (const item of cases) {
    const res = await runEval({ repo, width: item.width, height: item.height, view: item.view, wait: 1400, code: LAYOUT_PROBE })
    const r = res.result
    if (!r) {
      fail(`layout-${item.width}${item.view ? '-' + item.view : ''}`, 'P0', `${item.width}×${item.height}${item.view ? ' ' + item.view : ''} 无横向滚动/裁剪`, ['无 eval 结果'])
      continue
    }
    const keyOverflow = Object.entries(r.keys || {}).filter(([, v]) => v && (v.r > r.innerWidth + 2 || v.t < -2))
    const ok = r.overflowX <= 1 && (r.clipped || []).length === 0 && keyOverflow.length === 0
    ;(ok ? pass : fail)(`layout-${item.width}${item.view ? '-' + item.view : ''}`, 'P0', `${item.width}×${item.height}${item.view ? ' ' + item.view : ''} 无横向滚动/裁剪`, [
      `innerWidth=${r.innerWidth} doc=${r.docScrollWidth}/${r.docClientWidth} overflowX=${r.overflowX}`,
      `clipped=${JSON.stringify(r.clipped)}`,
      `keyOverflow=${JSON.stringify(keyOverflow.map(([k, v]) => [k, v.r]))}`
    ])
  }
}

async function runZoom() {
  log('')
  log('[verify] ===== 1920 窗口自适应缩放 =====')
  const res = await runEval({ repo, width: 1920, height: 1080, wait: 1400, code: ZOOM_PROBE, timeoutMs: 40000 })
  const r = res.result
  if (!r) return fail('zoom-1920', 'P1', '1920×1080 窗口下 innerWidth 约 1440–1600', ['无 eval 结果'])
  const ok = r.innerWidth >= 1440 && r.innerWidth <= 1600
  ;(ok ? pass : fail)('zoom-1920', 'P1', '1920×1080 窗口下 innerWidth 约 1440–1600（自适应放大）', [
    `innerWidth=${r.innerWidth} innerHeight=${r.innerHeight} dpr=${r.devicePixelRatio}`,
    '（本机屏幕 1707×1067 DIP，Windows 会把 1920 窗口钳制到工作区；缩放后 innerWidth 仍应落在区间内）'
  ])
}

async function runAdmin() {
  log('')
  log('[verify] ===== 管理员 / 控制台边界 =====')
  const res = await runEval({ repo, extra: 'demo=1', wait: 1500, code: ADMIN_PROBE, width: 1440, height: 900, timeoutMs: 45000 })
  const r = res.result
  if (!r) {
    fail('admin-auth-gate', 'P0', '管理员入口需要真实认证（对话框 + 密码），认证前不得进入管理终端', ['无 eval 结果'])
    fail('console-boundary', 'P1', '控制台/管理终端对普通用户不可直接操作', ['无 eval 结果'])
    return
  }
  const ev = [
    `items=${JSON.stringify(r.items)} adminClicked=${JSON.stringify(r.adminClicked)}`,
    `authDialog=${r.authDialog} passwordInput=${r.authPasswordInput}`,
    `adminPageBefore=${r.adminPageBefore} adminPageAfter=${r.adminPageAfter}`,
    `authText="${String(r.authText || '').slice(0, 260)}"`
  ]
  const authGate = (r.items || []).some((i) => /管理员/.test(i)) && r.authDialog && r.authPasswordInput && !r.adminPageBefore && !r.adminPageAfter && /密码/.test(r.authText || '')
  authGate
    ? pass('admin-auth-gate', 'P0', '管理员入口需要真实认证（对话框 + 密码），认证前不得进入管理终端', ev)
    : fail('admin-auth-gate', 'P0', '管理员入口需要真实认证（对话框 + 密码），认证前不得进入管理终端', ev)

  const boundaryEv = [
    `navLabels=${JSON.stringify(r.navLabels)} consoleVisible=${r.consoleVisible}`,
    `consoleSvcNote="${String(r.consoleSvcNote || '').slice(0, 200)}"`,
    `demoShell=${r.demoLabel}`,
    `adminPageRenderedWithoutAuth=${r.adminPageAfter}`,
    '说明：演示 shell 中的「控制台」是演示数据面板（显式进入演示后才能看到）；真实管理终端由 AdminAuthDialog 验证后才渲染；live 模式 consoleLocked 由 App.vue:179/1666 控制（无可用服务器，未联网实测）'
  ]
  !r.adminPageAfter && r.authDialog
    ? pass('console-boundary', 'P1', '控制台/管理终端对普通用户不可直接操作', boundaryEv)
    : fail('console-boundary', 'P1', '控制台/管理终端对普通用户不可直接操作', boundaryEv)
}

async function runService() {
  log('')
  log('[verify] ===== 本地服务缺失（公共版）=====')
  const res = await runEval({ repo, view: 'settings', wait: 1600, code: SERVICE_PROBE, width: 1440, height: 900, timeoutMs: 50000 })
  const r = res.result
  if (!r) {
    fail('service-neutral-copy', 'P0', '公共版无本地服务时显示中性说明（不是红色 ERROR code=1）', ['无 eval 结果'])
    fail('service-config-layers', 'P1', '本地服务配置有普通/高级分层 + 文件选择', ['无 eval 结果'])
    return
  }
  const allText = [r.cardTitle, r.cardDesc, ...(r.svcHints || []), r.contentTextBefore, r.contentTextAfter, r.consoleSvcNote, r.consoleText].join(' ')
  const rawError = /code=\s*1|\[ERROR\]|Exception|java\.lang|WebSocket|STOMP/.test(allText)
  const neutral = /未内置|公共版|连接远程房间|无需在本机|不需要本地服务/.test(allText)
  const ev = [
    `cardTitle="${r.cardTitle}"`,
    `cardDesc="${String(r.cardDesc || '').slice(0, 220)}"`,
    `svcHints=${JSON.stringify(r.svcHints)}`,
    `consoleSvcNote="${String(r.consoleSvcNote || '').slice(0, 220)}"`,
    `consoleFailure=${r.consoleFailure} consoleStartDisabled=${r.consoleStartDisabled}`,
    `rawErrorPattern=${rawError}`
  ]
  neutral && !rawError
    ? pass('service-neutral-copy', 'P0', '公共版无本地服务时显示中性说明（不是红色 ERROR code=1）', ev)
    : fail('service-neutral-copy', 'P0', '公共版无本地服务时显示中性说明（不是红色 ERROR code=1）', ev)

  const layersEv = [
    `advToggle="${String(r.advToggle || '').slice(0, 120)}" advBefore=${r.advBefore} advAfter=${r.advAfter}`,
    `chooseButtons=${JSON.stringify(r.chooseButtons)}`,
    `advButtons=${JSON.stringify(r.advButtons)}`,
    `fileInputs=${r.fileInputs}`
  ]
  const hasAdvanced = /高级/.test(String(r.advToggle || '')) && r.advAfter === true
  const hasPicker = (r.chooseButtons || []).some((b) => /选择/.test(b)) || (r.advButtons || []).some((b) => /选择/.test(b))
  hasAdvanced && hasPicker
    ? pass('service-config-layers', 'P1', '本地服务配置有普通/高级分层 + 文件选择', [...layersEv, '文件选择 IPC 由 service-file-picker-plumbing 静态检查'])
    : fail('service-config-layers', 'P1', '本地服务配置有普通/高级分层 + 文件选择', [...layersEv, `hasAdvanced=${hasAdvanced} hasPicker=${hasPicker}`])
}

async function runJoinErrors() {
  log('')
  log('[verify] ===== 加入错误提示 =====')
  const unreachable = await runEval({
    repo,
    extra: 'onboarding=1',
    wait: 1500,
    code: onboardingNetProbe('http://127.0.0.1:59999', { probe: true, maxMs: 13000 }),
    width: 1440,
    height: 900,
    timeoutMs: 60000
  })
  const ur = unreachable.result
  if (!ur) {
    fail('error-unreachable', 'P1', '服务器不可达时提示可理解（原因 + 下一步）', ['无 eval 结果'])
  } else {
    const ev = [`ms=${ur.ms}`, `probeClass="${ur.probeClass}"`, `probeText="${ur.probeText}"`, `errorText="${ur.errorText}"`]
    const ok = /fail/.test(ur.probeClass) && /无法连接|不可达|请检查|失败|网络/.test(ur.probeText + ' ' + ur.errorText)
    ;(ok ? pass : fail)('error-unreachable', 'P1', '服务器不可达时提示可理解（原因 + 下一步）', ev)
  }

  const wrong = await startWrongPasswordServer()
  try {
    const res = await runEval({
      repo,
      extra: 'onboarding=1',
      wait: 1500,
      code: onboardingNetProbe(wrong.url, { submit: true, maxMs: 13000 }),
      width: 1440,
      height: 900,
      timeoutMs: 55000
    })
    const r = res.result
    if (!r) fail('error-wrong-password', 'P1', '房间密码错误时提示可理解（明确指向密码）', ['无 eval 结果'])
    else {
      const ev = [`ms=${r.ms}`, `errorText="${r.errorText}"`, `probeText="${r.probeText}"`, `joining=${r.joining}`]
      const ok = /密码/.test(r.errorText) && !/INVALID_ROOM_PASSWORD|STOMP/.test(r.errorText)
      ;(ok ? pass : fail)('error-wrong-password', 'P1', '房间密码错误时提示可理解（明确指向密码）', ev)
    }
  } finally {
    await wrong.close()
  }

  const html = await startHtmlServer()
  try {
    const res = await runEval({
      repo,
      extra: 'onboarding=1',
      wait: 1500,
      code: onboardingNetProbe(html.url, { probe: true, maxMs: 13000 }),
      width: 1440,
      height: 900,
      timeoutMs: 55000
    })
    const r = res.result
    if (!r) fail('error-not-musicparty', 'P1', '非 MusicParty 地址提示可理解（可区分地址错误）', ['无 eval 结果'])
    else {
      const ev = [`ms=${r.ms}`, `probeClass="${r.probeClass}"`, `probeText="${r.probeText}"`]
      const ok = /fail/.test(r.probeClass) && /Music ?Party|不是|无法识别|配置/.test(r.probeText)
      ;(ok ? pass : fail)('error-not-musicparty', 'P1', '非 MusicParty 地址提示可理解（可区分地址错误）', ev)
    }
  } finally {
    await html.close()
  }
}

async function runKeyboard() {
  log('')
  log('[verify] ===== 键盘快捷方式 =====')
  const res = await runEval({ repo, extra: 'demo=1', wait: 1500, code: KEYBOARD_PROBE, width: 1440, height: 900 })
  const r = res.result
  if (!r) return fail('keyboard-shortcuts', 'P2', 'CTRL K / ESC / CTRL , 行为合理', ['无 eval 结果'])
  r.opened && r.closed && r.settingsOpened && r.settingsClosed
    ? pass('keyboard-shortcuts', 'P2', 'CTRL K / ESC / CTRL , 行为合理', [`palette open=${r.opened} close=${r.closed} settings open=${r.settingsOpened} close=${r.settingsClosed}`])
    : fail('keyboard-shortcuts', 'P2', 'CTRL K / ESC / CTRL , 行为合理', [`palette open=${r.opened} close=${r.closed} settings open=${r.settingsOpened} close=${r.settingsClosed}`])
}

/* ================================================================== */
/* main                                                                */
/* ================================================================== */

async function main() {
  const started = Date.now()
  fs.writeFileSync(logFile, '')
  const git = gitInfo(repo)
  const commit = arg('commit', process.env.MP_USABILITY_COMMIT || git.head)
  log('[verify] usability audit battery (public release)')
  log(`[verify] repo=${repo}`)
  log(`[verify] commit=${commit || '(unknown)'} dirty=${git.dirty} (${git.subject || ''})`)
  log(`[verify] tag=${tag} out=${outDir}`)
  log(`[verify] only=${only ? [...only].join(',') : '(all)'}`)

  let staticInfo = null
  try {
    log('')
    log('[verify] ===== 静态扫描：真实个人数据 / 硬编码 / 文档 =====')
    staticInfo = staticScan()
  } catch (error) {
    fail('static-personal-data', 'P0', '静态扫描执行失败', [String(error)])
  }

  if (want('nickname') || want('join-dialog')) await runNicknameDialog()
  if (want('first-launch') || want('onboarding')) await runFirstLaunch()
  if (want('layout')) await runLayout()
  if (want('zoom')) await runZoom()
  if (want('admin') || want('console')) await runAdmin()
  if (want('service')) await runService()
  if (want('errors') || want('join-error')) await runJoinErrors()
  if (want('keyboard')) await runKeyboard()

  const bySeverity = { P0: [], P1: [], P2: [] }
  for (const row of ROWS) (bySeverity[row.severity] || (bySeverity[row.severity] = [])).push(row)
  log('')
  log('[verify] ===== SUMMARY =====')
  for (const severity of ['P0', 'P1', 'P2']) {
    const rows = bySeverity[severity] || []
    if (!rows.length) continue
    log(`[verify] ${severity}: ${rows.filter((r) => r.pass).length}/${rows.length} PASS`)
    for (const row of rows) log(`[verify]   ${row.pass ? 'PASS' : 'FAIL'} ${row.id} — ${row.title}`)
  }
  const failed = (severity) => (bySeverity[severity] || []).filter((r) => !r.pass).length
  const p0Fail = failed('P0')
  const p1Fail = failed('P1')
  const p2Fail = failed('P2')
  log('')
  log(`[verify] TOTAL: P0 ${(bySeverity.P0 || []).length - p0Fail}/${(bySeverity.P0 || []).length} pass · P1 ${(bySeverity.P1 || []).length - p1Fail}/${(bySeverity.P1 || []).length} pass · P2 ${(bySeverity.P2 || []).length - p2Fail}/${(bySeverity.P2 || []).length} pass`)
  log(`[verify] VERDICT: ${p0Fail === 0 ? 'P0 clear' : p0Fail + ' P0 blocker(s)'}`)

  const manifestFile = path.join(outDir, 'manifest.json')
  let captureManifest = null
  try {
    if (fs.existsSync(manifestFile)) captureManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    captureManifest = null
  }

  const result = {
    tool: 'usability-verify',
    createdAt: new Date().toISOString(),
    repo,
    commit,
    tag,
    elapsedMs: Date.now() - started,
    summary: {
      P0: { total: (bySeverity.P0 || []).length, failed: p0Fail },
      P1: { total: (bySeverity.P1 || []).length, failed: p1Fail },
      P2: { total: (bySeverity.P2 || []).length, failed: p2Fail },
      verdict: p0Fail === 0 ? 'P0 clear' : `${p0Fail} P0 blocker(s)`
    },
    checks: ROWS,
    staticScan: staticInfo,
    captureManifest: captureManifest
      ? { screenshotCount: captureManifest.screenshotCount, scenarios: (captureManifest.scenarios || []).map((s) => ({ name: s.name, file: s.file, ok: s.ok })) }
      : null
  }
  fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2))
  fs.writeFileSync(logFile, LOG.join('\n') + '\n')
  log(`[verify] json: ${jsonFile}`)
  log(`[verify] log:  ${logFile}`)
  process.exit(0)
}

main().catch((error) => {
  console.error('[verify] fatal:', error)
  try {
    fs.writeFileSync(logFile, LOG.join('\n') + '\n[verify] fatal: ' + String(error) + '\n')
  } catch {}
  process.exit(1)
})

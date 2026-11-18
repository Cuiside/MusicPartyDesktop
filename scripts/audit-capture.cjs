'use strict'
/**
 * task-11 evidence capture: screenshots + DOM probes for the "hallucinated
 * features" audit and the sidebar IA audit.
 *
 * Read-only with respect to the app: this script only launches the built app
 * (dist/) with MP_SHOT / MP_EVAL_FILE, writes images/JSON under screenshots/audit/
 * and never touches src/, electron/ or package files.
 *
 * Usage:
 *   node scripts/audit-capture.cjs                 # all captures + probes
 *   node scripts/audit-capture.cjs --only shots    # only the shot.cjs-style captures
 *   node scripts/audit-capture.cjs --only probes   # only the DOM probes
 *   node scripts/audit-capture.cjs --only settings-room,admin-auth
 *
 * Serial: exactly one Electron instance at a time.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'screenshots', 'audit')
const EVAL_DIR = path.join(OUT, '_eval')
const LOG_FILE = path.join(OUT, '_capture.log')

const electron = require('electron')

function ensure() {
  fs.mkdirSync(EVAL_DIR, { recursive: true })
}

function log(line) {
  const text = String(line)
  console.log(text)
  fs.appendFileSync(LOG_FILE, text + '\n', 'utf8')
}

const sleepHelper = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel
    return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''
  }
  const exists = (sel) => Boolean(document.querySelector(sel))
`

/* ------------------------------------------------------------------ */
/* 1) plain screenshot captures (same mechanics as scripts/shot.cjs)   */
/* ------------------------------------------------------------------ */
const SHOTS = [
  { name: 'onboarding-1440', w: 1440, h: 900, extra: 'onboarding=1', note: '首次启动/加入界面：我的房间 + 加入房间两个真入口' },
  { name: 'onboarding-1024', w: 1024, h: 768, extra: 'onboarding=1', note: '首次启动 @ 最小宽' },
  { name: 'party-demo-1440', w: 1440, h: 900, view: 'party', note: '演示壳：派对现场（音质·极高 chip、transport 假按钮、检查器假操作）' },
  { name: 'party-demo-1024', w: 1024, h: 768, view: 'party', note: '演示壳：派对现场 @ 最小宽' },
  { name: 'queue-demo-1440', w: 1440, h: 900, view: 'queue', note: '演示壳：队列（拖拽提示/逐行点赞/侧栏 VIEWS 假入口）' },
  { name: 'search-demo-1440', w: 1440, h: 900, view: 'search', note: '演示壳：搜索（演示数据标注、命令栏分段/筛选）' },
  { name: 'chat-demo-1440', w: 1440, h: 900, view: 'chat', note: '演示壳：聊天（/help 提示、侧栏系统日志/命令帮助假入口）' },
  { name: 'history-demo-1440', w: 1440, h: 900, view: 'history', note: '演示壳：历史（128/37 写死演示统计，服务端无历史接口）' },
  { name: 'console-demo-1440', w: 1440, h: 900, view: 'console', note: '演示壳：控制台（假统计/假直播流/假房间控制/假播放控制）' },
  { name: 'console-demo-1024', w: 1024, h: 768, view: 'console', note: '演示壳：控制台 @ 最小宽' },
  { name: 'settings-play-1440', w: 1440, h: 900, view: 'settings', note: '设置·播放：假开关 + 假"保存更改"（仅音量生效）' },
  { name: 'join-dialog-1440', w: 1440, h: 900, view: 'party', extra: 'join=1', note: '加入房间对话框（我的房间/加入房间入口重复）' },
  { name: 'tutorial-drag-1440', w: 1440, h: 900, view: 'party', extra: 'tutorial=1&tutorialStep=2', note: '引导第 3 步：拖拽排序仅演示模式可用' },
  { name: 'tutorial-commands-1440', w: 1440, h: 900, view: 'party', extra: 'tutorial=1&tutorialStep=5', note: '引导第 6 步：/help 与 /vote skip 聊天命令（服务端不存在）' },
  { name: 'states-demo-1440', w: 1440, h: 900, view: 'states', note: '状态示例页（StateBlock 按钮无 action 处理）' }
]

function runShot(target) {
  return new Promise((resolve) => {
    const out = path.join(OUT, target.name + '.png')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.MP_SHOT = '1'
    env.MP_SHOT_OUT = out
    env.MP_SHOT_WAIT = String(target.wait || 2200)
    if (target.view) env.MP_SHOT_VIEW = target.view
    env.MP_SHOT_W = String(target.w)
    env.MP_SHOT_H = String(target.h)
    if (target.extra) env.MP_SHOT_EXTRA = target.extra
    const child = spawn(electron, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    const timer = setTimeout(() => child.kill(), 60000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const wrote = stdout.split(/\r?\n/).find((l) => l.includes('[shot] written'))
      if (wrote) log(`[shot] ${target.name}: ${wrote.trim()}`)
      else log(`[shot] ${target.name}: FAILED code=${code} ${stderr.split(/\r?\n/).slice(-2).join(' ')}`)
      target.file = path.relative(ROOT, out).replace(/\\/g, '/')
      resolve(Boolean(wrote))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      log(`[shot] ${target.name}: spawn error ${String(err)}`)
      resolve(false)
    })
  })
}

/* ------------------------------------------------------------------ */
/* 2) eval-driven captures + probes                                    */
/* ------------------------------------------------------------------ */
const SETTINGS_ROOM_EVAL = `
(async () => {
  ${sleepHelper}
  const nav = [...document.querySelectorAll('.settings-nav-item')].find((b) => text(b).includes('房间与权限'))
  if (nav) nav.click()
  await sleep(500)
  return { clicked: Boolean(nav), sectionTitle: text('.settings-title h2') }
})()
`

const ADMIN_AUTH_EVAL = `
(async () => {
  ${sleepHelper}
  const btn = document.querySelector('.titlebar .tb-btn[title="管理员登录"]') || [...document.querySelectorAll('.titlebar .tb-btn')][0]
  if (btn) btn.click()
  await sleep(500)
  return { clicked: Boolean(btn), dialog: exists('.admin-auth-backdrop, .admin-auth, .dialog-backdrop') }
})()
`

const PARTY_FILTERS_EVAL = `
(async () => {
  ${sleepHelper}
  const chips = [...document.querySelectorAll('.commandbar .chip-btn')].filter((b) => !b.classList.contains('icon-only'))
  const before = {
    title: text('.cmd-title h1'),
    filters: chips.map((b) => ({ label: text(b), pressed: b.classList.contains('pressed') })),
    rows: document.querySelectorAll('.qrow').length
  }
  chips.forEach((b) => b.click())
  await sleep(350)
  const after = {
    title: text('.cmd-title h1'),
    filters: [...document.querySelectorAll('.commandbar .chip-btn')].filter((b) => !b.classList.contains('icon-only')).map((b) => ({ label: text(b), pressed: b.classList.contains('pressed') })),
    rows: document.querySelectorAll('.qrow').length
  }
  const segsBefore = [...document.querySelectorAll('.commandbar .seg')].map((b) => ({ label: text(b), active: b.classList.contains('active') }))
  const segs = [...document.querySelectorAll('.commandbar .seg')]
  ;(segs[2] || segs[0])?.click()
  await sleep(300)
  const segsAfter = [...document.querySelectorAll('.commandbar .seg')].map((b) => ({ label: text(b), active: b.classList.contains('active') }))
  return { before, after, segsBefore, segsAfter }
})()
`

/* Sidebar items: click every item and report whether anything observable happened.
   "Observable" = command-bar title / overlay open-close / toast text / active nav. */
const PROBE_SIDEBAR_EVAL = `
(async () => {
  ${sleepHelper}
  const state = () => ({
    title: text('.cmd-title h1'),
    settings: Boolean(document.querySelector('.settings')),
    join: Boolean(document.querySelector('.join-dialog') || document.querySelector('.dialog-backdrop')),
    palette: Boolean(document.querySelector('.palette')),
    confirm: Boolean(document.querySelector('.dialog-backdrop')),
    toast: text('.toast'),
    nav: text('.nav-item.active')
  })
  const closeOverlays = async () => {
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await sleep(80)
    }
  }
  const probe = async (navTitle) => {
    const nav = [...document.querySelectorAll('.nav-item')].find((b) => (b.title || text(b)) === navTitle)
    if (nav) nav.click()
    await sleep(400)
    const items = [...document.querySelectorAll('.side-item')]
    const rows = []
    for (const el of items) {
      const label = text(el)
      const before = state()
      el.click()
      await sleep(180)
      const after = state()
      const changed = JSON.stringify(before) !== JSON.stringify(after)
      rows.push({ label, changed, delta: changed ? { title: after.title, settings: after.settings, join: after.join, toast: after.toast, nav: after.nav } : null })
      await closeOverlays()
    }
    return rows
  }
  const queue = await probe('队列')
  const party = await probe('派对')
  return { queue, party }
})()
`

const PROBE_COMMAND_EVAL = `
(async () => {
  ${sleepHelper}
  const nav = [...document.querySelectorAll('.nav-item')].find((b) => (b.title || text(b)) === '队列')
  if (nav) nav.click()
  await sleep(400)
  const snap = () => ({
    title: text('.cmd-title h1'),
    rows: document.querySelectorAll('.qrow').length,
    first: text('.qrow .qtitle'),
    totalLabel: text('.queue-foot .label')
  })
  const segs = [...document.querySelectorAll('.commandbar .seg')]
  const filters = [...document.querySelectorAll('.commandbar .chip-btn')].filter((b) => !b.classList.contains('icon-only'))
  const segRows = []
  for (const seg of segs) {
    const before = snap()
    seg.click()
    await sleep(260)
    segRows.push({ label: text(seg), activeAfter: seg.classList.contains('active'), dataChanged: JSON.stringify(before) !== JSON.stringify(snap()), before, after: snap() })
  }
  const filterRows = []
  for (const chip of filters) {
    const before = snap()
    chip.click()
    await sleep(260)
    filterRows.push({ label: text(chip), pressedAfter: chip.classList.contains('pressed'), dataChanged: JSON.stringify(before) !== JSON.stringify(snap()) })
  }
  return { segRows, filterRows }
})()
`

const EVALS = [
  {
    name: 'settings-room',
    view: 'settings',
    eval: SETTINGS_ROOM_EVAL,
    shot: true,
    note: '设置·房间与权限：管理员密码/房间密码/人数/限流均为本地假表单'
  },
  {
    name: 'admin-auth',
    view: 'party',
    eval: ADMIN_AUTH_EVAL,
    shot: true,
    note: '标题栏管理员登录（真实 /api/admin/verify 流程）'
  },
  {
    name: 'party-filters',
    view: 'party',
    eval: PARTY_FILTERS_EVAL,
    shot: true,
    note: '命令栏分段/筛选点击后仅改视觉，不改变任何数据'
  },
  {
    name: 'probe-sidebar',
    view: 'party',
    eval: PROBE_SIDEBAR_EVAL,
    shot: false,
    json: true,
    note: '逐个点击侧栏条目，记录是否产生任何可观察行为'
  },
  {
    name: 'probe-commandbar',
    view: 'queue',
    eval: PROBE_COMMAND_EVAL,
    shot: false,
    json: true,
    note: '队列页分段/筛选点击前后的数据快照'
  }
]

function runEval(target) {
  return new Promise((resolve) => {
    const evalFile = path.join(EVAL_DIR, target.name + '.js')
    fs.writeFileSync(evalFile, target.eval, 'utf8')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.MP_EVAL_FILE = evalFile
    env.MP_EVAL_WAIT = String(target.wait || 2200)
    if (target.view) env.MP_SHOT_VIEW = target.view
    env.MP_SHOT_W = '1440'
    env.MP_SHOT_H = '900'
    if (target.extra) env.MP_SHOT_EXTRA = target.extra
    let outFile = ''
    if (target.shot) {
      outFile = path.join(OUT, target.name + '.png')
      env.MP_SHOT = '1'
      env.MP_SHOT_OUT = outFile
      target.file = path.relative(ROOT, outFile).replace(/\\/g, '/')
    }
    const child = spawn(electron, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    const timer = setTimeout(() => child.kill(), 60000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/).find((l) => l.includes('[eval] result '))
      if (!line) {
        log(`[eval] ${target.name}: NO RESULT code=${code} ${stderr.split(/\r?\n/).slice(-2).join(' ')}`)
        target.ok = false
        return resolve(false)
      }
      const raw = line.slice(line.indexOf('[eval] result ') + '[eval] result '.length)
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        log(`[eval] ${target.name}: bad JSON ${String(error)}`)
      }
      target.result = parsed
      if (target.json) {
        const jsonFile = path.join(OUT, target.name + '.json')
        fs.writeFileSync(jsonFile, JSON.stringify(parsed, null, 2), 'utf8')
        target.file = path.relative(ROOT, jsonFile).replace(/\\/g, '/')
        log(`[eval] ${target.name}: ${path.relative(ROOT, jsonFile)}`)
      }
      if (target.shot) {
        const wrote = stdout.split(/\r?\n/).find((l) => l.includes('[shot] written'))
        log(`[shot] ${target.name}: ${wrote ? wrote.trim() : 'FAILED'}`)
      }
      target.ok = true
      resolve(true)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      log(`[eval] ${target.name}: spawn error ${String(err)}`)
      resolve(false)
    })
  })
}

/* ------------------------------------------------------------------ */
async function main() {
  ensure()
  const onlyIdx = process.argv.indexOf('--only')
  const only = onlyIdx >= 0 ? new Set(String(process.argv[onlyIdx + 1] || '').split(',').filter(Boolean)) : null
  const wantShots = !only || only.has('shots') || [...only].some((n) => SHOTS.some((s) => s.name === n))
  const wantEvals = !only || only.has('probes') || [...only].some((n) => EVALS.some((s) => s.name === n))

  fs.writeFileSync(LOG_FILE, `# audit-capture ${new Date().toISOString()}\n`, 'utf8')
  const manifest = { startedAt: new Date().toISOString(), head: '', shots: SHOTS, evals: EVALS }
  try {
    const { spawnSync } = require('node:child_process')
    manifest.head = String(spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim()
    manifest.gitSubject = String(spawnSync('git', ['-C', ROOT, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).stdout || '').trim()
  } catch {
    /* ignore */
  }

  if (wantShots) {
    const list = only ? SHOTS.filter((s) => only.has(s.name) || only.has('shots')) : SHOTS
    log(`[audit] shots: ${list.length}`)
    for (const shot of list) await runShot(shot)
  }
  if (wantEvals) {
    const list = only ? EVALS.filter((e) => only.has(e.name) || only.has('probes')) : EVALS
    log(`[audit] evals: ${list.length}`)
    for (const item of list) await runEval(item)
  }

  manifest.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  log('[audit] done -> screenshots/audit/manifest.json')
}

main()

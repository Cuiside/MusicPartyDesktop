'use strict'
/**
 * Public-release usability audit · screenshot pass (new public build).
 *
 * Serial captures of the user-facing states the complaints are about: the genuine first
 * launch onboarding page, 「我的房间」/「加入房间」 targets, explicit demo entry + return,
 * the public-build local-service explanation, admin auth gating, error states and the
 * 1024/1440/1920 layouts.
 *
 * Usage:
 *   node scripts/usability-capture.cjs --tag final
 *   node scripts/usability-capture.cjs --tag final --only first-launch,admin
 *   node scripts/usability-capture.cjs --tag baseline --repo E:\example-baseline-c7c5594 --commit c7c5594
 *
 * Output: <outRoot>/<tag>/NN-name-WxH.png + manifest.json + _capture.log.
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
  runShot,
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
const rootOut = outRoot()
const outDir = path.resolve(arg('out', path.join(rootOut, tag)))
const only = (() => {
  const raw = arg('only', '')
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null
})()
const logFile = path.join(outDir, '_capture.log')
const manifestFile = path.join(outDir, 'manifest.json')

const LOG = []
let current = null
const log = (line) => {
  LOG.push(String(line))
  console.log(String(line))
}
const note = (text) => current && current.notes.push(text)

/* ------------------------------------------------------------------ */
/* probes                                                              */
/* ------------------------------------------------------------------ */

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
    nickname: (document.querySelector('#onb-nickname') || {}).value || null,
    mineHost: txt('.onb-room-host'),
    mineTag: txt('.onb-room-tag'),
    privacyText: txt('.onb-privacy'),
    demoButton: !!document.querySelector('#onb-demo'),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 900)
  }
})()`

const ONBOARDING_JOIN_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const joinTab = document.querySelector('#onb-tab-join')
  if (joinTab) joinTab.click()
  await sleep(450)
  let input = document.querySelector('#onb-join-server')
  if (!input) {
    const adv = document.querySelector('.onb-server-row')
    if (adv) adv.click()
    await sleep(450)
    input = document.querySelector('#onb-join-server')
  }
  if (input) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    desc.set.call(input, 'https://friend-room.example.com')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await sleep(350)
  return {
    joinInput: !!input,
    joinValue: (document.querySelector('#onb-join-server') || {}).value || '',
    targetHost: txt(document.querySelector('.onb-server-value')),
    advancedHint: txt(document.querySelector('.onb-advanced-hint')),
    privacyText: txt(document.querySelector('.onb-privacy')),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000)
  }
})()`

const DEMO_ENTER_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const before = !!document.querySelector('#onboarding, .onboarding')
  const demo = document.querySelector('#onb-demo')
  if (demo) demo.click()
  await sleep(1100)
  const skip = [...document.querySelectorAll('.tutorial button')].find((b) => /跳过/.test(b.textContent || ''))
  if (skip) { skip.click(); await sleep(400) }
  return {
    onboardingBefore: before,
    onboardingAfter: !!document.querySelector('#onboarding, .onboarding'),
    demoBanner: !!document.querySelector('.demo-banner'),
    demoBannerText: txt(document.querySelector('.demo-banner')),
    workspace: !!document.querySelector('.mp-workspace-row'),
    returnCta: txt(document.querySelector('.demo-banner-return')),
    tutorialSkipped: !!skip
  }
})()`

const DEMO_RETURN_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const demo = document.querySelector('#onb-demo')
  if (demo) demo.click()
  await sleep(1100)
  const skip = [...document.querySelectorAll('.tutorial button')].find((b) => /跳过/.test(b.textContent || ''))
  if (skip) { skip.click(); await sleep(400) }
  const back = document.querySelector('.demo-banner-return')
  if (back) back.click()
  await sleep(900)
  return {
    onboardingAfterReturn: !!document.querySelector('#onboarding, .onboarding'),
    demoBannerAfterReturn: !!document.querySelector('.demo-banner'),
    privacyText: (function () { const el = document.querySelector('.onb-privacy'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' })()
  }
})()`

const SETTINGS_SERVICE_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const navs = [...document.querySelectorAll('.settings-nav-item')]
  const target = navs.find((b) => /服务/.test(b.textContent || ''))
  if (target) target.click()
  await sleep(700)
  const out = {
    navLabels: navs.map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
    cardTitle: txt(document.querySelector('.svc-card-title')),
    cardDesc: txt(document.querySelector('.svc-card-desc')),
    svcHints: [...document.querySelectorAll('.svc-hint')].map(txt).filter(Boolean)
  }
  const adv = document.querySelector('.svc-adv-toggle')
  out.advancedToggle = txt(adv)
  if (adv) { adv.click(); await sleep(500) }
  out.advancedVisible = !!document.querySelector('.svc-adv')
  out.chooseButtons = [...document.querySelectorAll('.settings button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).filter((t) => /选择|浏览/.test(t))
  out.bodyText = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1500)
  return out
})()`

const SETTINGS_ROOM_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const navs = [...document.querySelectorAll('.settings-nav-item')]
  const target = navs.find((b) => /房间/.test(b.textContent || ''))
  if (target) target.click()
  await sleep(600)
  const rows = [...document.querySelectorAll('.settings-form .setting-row')].map((row) => ({
    name: ((row.querySelector('.setting-name') || {}).textContent || '').trim(),
    desc: ((row.querySelector('.setting-desc') || {}).textContent || '').replace(/\\s+/g, ' ').trim()
  }))
  return { rows }
})()`

const CONSOLE_SERVICE_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const navs = [...document.querySelectorAll('.nav-item')]
  const btn = navs.find((b) => /控制台/.test((b.textContent || '') + (b.title || '')))
  if (btn) btn.click()
  await sleep(800)
  const guide = [...document.querySelectorAll('.console-grid button')].find((b) => /如何启用|启用文档|查看启用/.test(b.textContent || ''))
  if (guide) { guide.click(); await sleep(500) }
  return {
    consoleVisible: !!document.querySelector('.console-grid'),
    svcNote: txt(document.querySelector('.svc-note')).slice(0, 800),
    guideOpen: !!document.querySelector('.svc-note-guide'),
    guideText: txt(document.querySelector('.svc-note-guide')).slice(0, 900),
    consoleText: txt(document.querySelector('.console-grid')).slice(0, 1200)
  }
})()`

const ACCOUNT_MENU_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const trigger = document.querySelector('.nav-account')
  if (trigger) trigger.click()
  await sleep(450)
  const menu = document.querySelector('.ctxmenu')
  return {
    triggerTitle: trigger ? trigger.getAttribute('title') : '',
    items: menu ? [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()) : []
  }
})()`

const ADMIN_AUTH_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const trigger = document.querySelector('.nav-account')
  if (trigger) trigger.click()
  await sleep(450)
  const menu = document.querySelector('.ctxmenu')
  const admin = menu ? [...menu.querySelectorAll('.ctx-item')].find((b) => /管理员/.test(b.textContent || '')) : null
  if (admin) admin.click()
  await sleep(800)
  return {
    dialog: !!document.querySelector('.admin-auth-dialog'),
    dialogText: txt(document.querySelector('.admin-auth-dialog')).slice(0, 900),
    passwordInput: !!document.querySelector('#admin-auth-password'),
    adminPage: !!document.querySelector('.admin-page')
  }
})()`

function onboardingNetProbe(url, options = {}) {
  const target = JSON.stringify(String(url || ''))
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
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
  }
  await sleep(300)
  const check = [...document.querySelectorAll('.onb-check')].find((b) => b.getBoundingClientRect().width > 2)
  if (${options.probe === true} && check) check.click()
  if (${options.submit === true}) {
    const submit = document.querySelector('#onb-submit-join')
    if (submit) submit.click()
  }
  const started = Date.now()
  let probeText = ''
  let probeClass = ''
  let errorText = ''
  while (Date.now() - started < ${Number(options.maxMs || 12000)}) {
    const p = document.querySelector('.onb-probe-result')
    probeText = txt(p)
    probeClass = p ? String(p.className) : ''
    errorText = txt(document.querySelector('#onb-error')) || txt(document.querySelector('.onb-error'))
    if (${options.probe === true} && /fail|ok/.test(probeClass)) break
    if (${options.submit === true} && errorText) break
    await sleep(200)
  }
  return { ms: Date.now() - started, probeText, probeClass, errorText }
})()`
}

/* ------------------------------------------------------------------ */
/* scenarios                                                           */
/* ------------------------------------------------------------------ */

const TUTORIAL_PROBE = `(() => {
  const txt = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' }
  return { tutorial: !!document.querySelector('.tutorial'), label: txt('.tutorial-head .label'), title: txt('.tutorial-title'), text: txt('.tutorial-text') }
})()`

const SCENARIOS = [
  { name: 'first-launch', kind: 'genuine', width: 1440, height: 900, probe: FIRST_LAUNCH_PROBE, title: '真实首启 · 引导页（我的房间默认）1440' },
  { name: 'first-launch', kind: 'genuine', width: 1024, height: 768, probe: FIRST_LAUNCH_PROBE, title: '真实首启 · 引导页 1024' },
  { name: 'first-launch-zoom', kind: 'genuine', width: 1920, height: 1080, probe: FIRST_LAUNCH_PROBE, title: '1920×1080 真实首启（自适应缩放 innerWidth）' },
  { name: 'onboarding-join', kind: 'genuine', width: 1440, height: 900, probe: ONBOARDING_JOIN_PROBE, title: '引导页 · 加入房间（远程/邀请地址）' },
  { name: 'demo-mode', kind: 'genuine', width: 1440, height: 900, probe: DEMO_ENTER_PROBE, title: '显式进入演示模式（演示数据标识）' },
  { name: 'demo-return', kind: 'genuine', width: 1440, height: 900, probe: DEMO_RETURN_PROBE, title: '演示模式 → 返回加入界面' },
  { name: 'join-dialog', kind: 'shot', width: 1440, height: 900, extra: 'join=1', title: '加入房间弹窗 1440' },
  { name: 'join-dialog', kind: 'shot', width: 1024, height: 768, extra: 'join=1', title: '加入房间弹窗 1024' },
  { name: 'demo-home', kind: 'shot', width: 1440, height: 900, extra: 'demo=1', title: '演示模式工作区 1440' },
  { name: 'demo-home', kind: 'shot', width: 1024, height: 768, extra: 'demo=1', title: '演示模式工作区 1024' },
  { name: 'settings-service', kind: 'shot', width: 1440, height: 900, view: 'settings', probe: SETTINGS_SERVICE_PROBE, title: '设置 · 服务与连接（中性说明 + 高级设置 + 文件选择）' },
  { name: 'settings-service', kind: 'shot', width: 1024, height: 768, view: 'settings', probe: SETTINGS_SERVICE_PROBE, title: '设置 · 服务与连接 1024' },
  { name: 'settings-room', kind: 'shot', width: 1440, height: 900, view: 'settings', probe: SETTINGS_ROOM_PROBE, title: '设置 · 房间与权限' },
  { name: 'console-service', kind: 'shot', width: 1440, height: 900, extra: 'demo=1', probe: CONSOLE_SERVICE_PROBE, title: '控制台 · 本地服务中性说明 + 启用引导' },
  { name: 'console-service', kind: 'shot', width: 1024, height: 768, extra: 'demo=1', probe: CONSOLE_SERVICE_PROBE, title: '控制台 · 服务说明 1024' },
  { name: 'account-menu', kind: 'shot', width: 1440, height: 900, extra: 'demo=1', probe: ACCOUNT_MENU_PROBE, title: '账号菜单（管理员认证入口）' },
  { name: 'admin-auth', kind: 'shot', width: 1440, height: 900, extra: 'demo=1', probe: ADMIN_AUTH_PROBE, title: '管理员认证对话框（普通用户不可直接操作）' },
  { name: 'tutorial', kind: 'shot', width: 1440, height: 900, extra: 'tutorial=1', probe: TUTORIAL_PROBE, title: '界面聚光灯引导（首启教程）' },
  { name: 'error-unreachable', kind: 'shot', width: 1440, height: 900, extra: 'onboarding=1', probe: onboardingNetProbe('http://127.0.0.1:59999', { probe: true, maxMs: 12000 }), probeWait: 1600, title: '错误态 · 服务器不可达（引导页检测）' },
  { name: 'error-wrong-password', kind: 'shot', width: 1440, height: 900, extra: 'onboarding=1', fake: 'wrong-password', probe: onboardingNetProbe('__FAKE__', { submit: true, maxMs: 12000 }), probeWait: 1600, title: '错误态 · 房间密码错误' },
  { name: 'error-not-musicparty', kind: 'shot', width: 1440, height: 900, extra: 'onboarding=1', fake: 'html', probe: onboardingNetProbe('__FAKE__', { probe: true, maxMs: 12000 }), probeWait: 1600, title: '错误态 · 非 MusicParty 地址' }
]

const shouldRun = (scenario) => {
  if (!only) return true
  for (const key of only) if (scenario.name === key || scenario.name.startsWith(key + '-')) return true
  return false
}

const fileFor = (scenario) => path.join(outDir, `${String(current.index).padStart(2, '0')}-${scenario.name}-${scenario.width}x${scenario.height}.png`)
const relativeOut = (file) => path.relative(rootOut, file).replace(/\\/g, '/')

async function runGenuine(scenario) {
  const shot = fileFor(scenario)
  const res = await withGenuineApp({
    repo,
    width: scenario.width,
    height: scenario.height,
    run: async ({ eval: evalInPage, screenshot }) => {
      const result = await evalInPage(scenario.probe || FIRST_LAUNCH_PROBE, 30000)
      await screenshot(shot)
      return result
    }
  })
  return { shot, res }
}

async function main() {
  const started = Date.now()
  ensureDir(outDir)
  fs.writeFileSync(logFile, '')
  const git = gitInfo(repo)
  const commit = arg('commit', process.env.MP_USABILITY_COMMIT || git.head)
  log(`[capture] repo=${repo}`)
  log(`[capture] commit=${commit || '(unknown)'} dirty=${git.dirty} (${git.subject || ''})`)
  log(`[capture] out=${outDir} tag=${tag} scenarios=${SCENARIOS.filter(shouldRun).length}`)
  log('')

  const manifest = { tool: 'usability-capture', createdAt: new Date().toISOString(), repo, git: { ...git, commit }, tag, outDir, scenarios: [] }
  const fakeServers = []
  try {
    for (let index = 0; index < SCENARIOS.length; index += 1) {
      const scenario = SCENARIOS[index]
      if (!shouldRun(scenario)) continue
      current = { index: index + 1, name: scenario.name, notes: [], startedAt: new Date().toISOString() }
      log(`[capture] (${index + 1}/${SCENARIOS.length}) ${scenario.name} ${scenario.width}x${scenario.height} — ${scenario.title}`)
      const row = { name: scenario.name, title: scenario.title, kind: scenario.kind, width: scenario.width, height: scenario.height, extra: scenario.extra || '', file: '', abs: '', ok: false, result: null, error: '', notes: [] }
      try {
        if (scenario.kind === 'genuine') {
          const { shot, res } = await runGenuine(scenario)
          row.file = relativeOut(shot)
          row.abs = shot
          row.ok = res.ok && fs.existsSync(shot)
          row.result = res.result || null
          row.error = res.ok ? '' : res.error
          if (!res.ok) log(`[capture]   genuine launch failed: ${res.error}`)
        } else {
          let extra = scenario.extra || ''
          let probe = scenario.probe
          if (scenario.fake) {
            const server = scenario.fake === 'wrong-password' ? await startWrongPasswordServer() : await startHtmlServer()
            fakeServers.push(server)
            extra = `onboarding=1&server=${encodeURIComponent(server.url)}`
            if (scenario.fake === 'wrong-password') extra += `&password=wrong-password-123`
            probe = String(probe).replace('__FAKE__', server.url)
            log(`[capture]   fake server: ${server.url} (${scenario.fake})`)
          }
          const shot = fileFor(scenario)
          const res = await runShot({
            repo,
            outFile: shot,
            width: scenario.width,
            height: scenario.height,
            view: scenario.view,
            extra,
            evalCode: probe,
            evalWait: scenario.probeWait || 1600,
            wait: 2200,
            timeoutMs: 60000
          })
          row.file = relativeOut(shot)
          row.abs = shot
          row.ok = fs.existsSync(shot)
          row.result = res.result || null
          row.evalFailed = res.evalFailed || null
          if (!row.ok) row.error = `exit=${res.code} timedOut=${res.timedOut}`
          if (res.timedOut) row.error = 'timed out'
          log(`[capture]   shot=${row.ok ? 'ok' : 'MISSING'} exit=${res.code} eval=${res.result ? 'ok' : res.evalFailed ? 'failed' : 'none'}`)
        }
        if (row.result) row.notes.push('probe=' + JSON.stringify(row.result).slice(0, 700))
      } catch (error) {
        row.error = String(error && error.message ? error.message : error)
      }
      if (row.error) note(row.error)
      row.notes = current.notes
      row.finishedAt = new Date().toISOString()
      manifest.scenarios.push(row)
      log(`[capture]   ${row.ok && !row.error ? 'DONE' : 'WARN'} ${row.name}${row.error ? ' — ' + row.error : ''}`)
      log('')
    }
  } finally {
    for (const server of fakeServers) await server.close().catch(() => {})
  }

  manifest.elapsedMs = Date.now() - started
  manifest.screenshotCount = manifest.scenarios.filter((s) => s.ok).length
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  fs.writeFileSync(logFile, LOG.join('\n') + '\n')
  log(`[capture] SUMMARY ${manifest.screenshotCount}/${manifest.scenarios.length} screenshots in ${(manifest.elapsedMs / 1000).toFixed(1)}s`)
  log(`[capture] manifest: ${manifestFile}`)
  process.exit(manifest.screenshotCount === manifest.scenarios.length ? 0 : 1)
}

main().catch((error) => {
  console.error('[capture] fatal:', error)
  process.exit(1)
})

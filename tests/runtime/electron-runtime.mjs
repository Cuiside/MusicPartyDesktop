#!/usr/bin/env node
/**
 * Electron 运行时独立回归（D-01 队列自动选中、D-13 歌词竞态、D-14 会话音频清理、
 * D-15 游客门禁、D-02/D-12 地址与 session base）。
 *
 * 用法：
 *   node tests/runtime/electron-runtime.mjs [--label runtime-<tag>] [--keep-vite]
 *
 * 运行方式：程序内启动 Vite dev server（127.0.0.1:5173）→ 以 MP_DEV=1 启动真实
 * Electron（未打补丁的开发入口）→ 在渲染进程执行 MP_EVAL 探针（main.cjs 既有自动化钩子）
 * → 断言真实 DOM/模块行为。不修改 App.vue/业务源码，不接触生产服务器。
 *
 * 结果写入 E:\example-delivery\verification\runtime-<label>\SUMMARY.json 与
 * docs/verification/results-runtime-<label>.json。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(HERE, '..', '..')
const VITE_PORT = 5173
const { Collector, writeRunSummary } = await import('../regression/lib/results.mjs')
const { ensureDir, isPortListening, nowIso, parseArgs, sleep, waitPortFree } = await import('../regression/lib/env.mjs')

const args = parseArgs()
const label = String(args.label || `runtime-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`)
const OUT_DIR = path.join(process.env.MP_VERIFICATION_ROOT || path.join(os.tmpdir(), 'musicparty-verification'), label)
const DOCS_COPY = path.join(DESKTOP_ROOT, 'docs', 'verification', `results-${label}.json`)

const SONG_A = {
  id: 'fixture-runtime-a',
  queueId: 'fixture-runtime-qa',
  title: 'Runtime Audit A',
  artist: 'Fixture',
  source: 'netease',
  sourceLabel: '网易云',
  duration: 120,
  state: 'queued'
}
const SONG_B = { ...SONG_A, id: 'fixture-runtime-b', queueId: 'fixture-runtime-qb', title: 'Runtime Audit B' }

/** Renderer probe evaluated inside the real Electron renderer. */
function buildEvalCode(lyricMockUrl) {
  return `(async () => {
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const song = (s) => ({ ...s })
  try {
    // The renderer may still be evaluating the (large) Vite module graph when MP_EVAL
    // fires; wait for the QA handle instead of assuming a fixed delay.
    const waitStarted = Date.now()
    while (!window.__mp && Date.now() - waitStarted < 25000) await sleep(100)
    if (!window.__mp) throw new Error('window.__mp debug handle not ready after 25s (renderer mount timeout)')
    out.boot = {
      appChildren: document.querySelector('#app')?.children.length ?? -1,
      bodyTextLength: document.body.innerText.length,
      hasDebug: Boolean(window.__mp),
      hasProtocolProbe: Boolean(window.__mp?.protocol),
      protocolBase: window.__mp?.protocol?.sessionBase?.() ?? null
    }
    const l = window.__mp.live
    const titles = () => [...document.querySelectorAll('.inspector-title')].map((e) => e.textContent.trim())
    const trackTitle = () => document.querySelector('.inspector .track-title')?.textContent?.trim() ?? null

    // ---- D-01: adding to the live queue must auto-select the track inspector ----
    l.joined = true
    l.connected = true
    await sleep(150)
    l.queue = [song(${JSON.stringify(SONG_B)})]
    // The inspector uses a Vue <Transition mode="out-in">; wait until the outgoing
    // RoomInspector has fully left and the TrackInspector is mounted.
    await sleep(1400)
    out.d01Add = { filteredQueueCount: window.__mp.ui.filteredQueueCount(), inspectorTitles: titles(), trackTitle: trackTitle() }

    l.queue = [song(${JSON.stringify(SONG_A)}), song(${JSON.stringify(SONG_B)})]
    await sleep(1000)
    out.d01Replace = { filteredQueueCount: window.__mp.ui.filteredQueueCount(), inspectorTitles: titles(), trackTitle: trackTitle() }

    l.queue = [song(${JSON.stringify(SONG_B)})]
    await sleep(1000)
    out.d01DeleteCurrent = { filteredQueueCount: window.__mp.ui.filteredQueueCount(), inspectorTitles: titles(), trackTitle: trackTitle() }

    l.queue = []
    await sleep(1000)
    out.d01Clear = { filteredQueueCount: window.__mp.ui.filteredQueueCount(), inspectorTitles: titles(), trackTitle: trackTitle() }

    // ---- D-13: real lyric race through App.vue's own watcher + mock backend ------
    // Point REST at the local mock so the renderer really requests lyrics (slow/fast ids
    // are delayed by the mock) instead of failing against a nonexistent server.
    const config = await import('/src/core/live/config.js')
    config.saveSettings({ serverUrl: ${JSON.stringify('__LYRIC_MOCK_URL__')} })
    const lyricMock = ${JSON.stringify(lyricMockUrl)}
    out.d13Setup = { mockUrl: lyricMock, configured: config.loadSettings().serverUrl }
    l.joined = true
    l.nowPlaying = { id: 'slow', source: 'netease' }
    await sleep(80)
    l.nowPlaying = { id: 'fast', source: 'netease' }
    await sleep(900)
    out.d13Race = { displayed: l.lyrics[0]?.text ?? null, protocolLyrics: window.__mp.protocol.lyrics() }

    l.lyrics = []
    l.nowPlaying = { id: 'slowfail', source: 'netease' }
    await sleep(80)
    l.nowPlaying = { id: 'fast', source: 'netease' }
    await sleep(900)
    out.d13StaleFailure = { displayed: l.lyrics[0]?.text ?? null }

    // ---- D-15: guest commands are rejected locally with a machine code ----
    const client = await import('/src/core/live/client.js')
    l.identity = { id: 'fixture-renderer-guest', name: '游客', isGuest: true }
    l.connected = true
    out.d15Guest = {
      enqueue: await client.addToQueue({ id: 'fixture-runtime-track', source: 'netease' }),
      chat: await client.sendChat('fixture renderer guest chat')
    }

    // ---- D-02 / D-12: address normalization + immutable session base ----
    const sessionMod = await import('/src/core/live/session.js')
    out.d02 = {
      bare: config.normalizeServerUrl('music.example.com'),
      loopback: config.normalizeServerUrl('127.0.0.1:8080'),
      invalid: config.normalizeServerUrl('%%%'),
      parseInvalid: config.parseServerUrl('%%%')?.ok
    }
    sessionMod.beginSession('https://music.example.com/prefix')
    config.saveSettings({ serverUrl: 'http://127.0.0.1:18899' })
    out.d12 = { sessionAddress: sessionMod.sessionAddress(), activeBase: sessionMod.activeBase() }
    sessionMod.endSession()
    config.saveSettings({ serverUrl: 'http://127.0.0.1:18848' })

    // ---- D-14: internal session teardown must stop the audio engine ----
    const engine = window.__mp.engine
    engine.mute(true)
    const n = 44100 * 5
    const buffer = new ArrayBuffer(44 + n * 2)
    const view = new DataView(buffer)
    const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 44100, true); view.setUint32(28, 88200, true); view.setUint16(32, 2, true)
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, n * 2, true)
    let raw = ''
    for (const b of new Uint8Array(buffer)) raw += String.fromCharCode(b)
    l.joined = true
    l.connected = true
    l.playing = true
    l.progress = 0
    l.nowPlaying = { id: 'fixture-runtime-d14', source: 'netease', url: 'data:audio/wav;base64,' + btoa(raw), duration: 5, playableDuration: 5 }
    // Drive the component through the same authoritative state as a real room;
    // manually playing while server state is paused races the synchronization watcher.
    await sleep(700)
    const before = { playing: engine.playing, joined: l.joined }
    await client.leaveRoom()
    await sleep(400)
    out.d14 = {
      before,
      after: {
        playing: engine.playing,
        joined: l.joined,
        nowPlaying: l.nowPlaying,
        lyricCount: l.lyrics.length,
        progress: l.progress
      }
    }
    try { engine.pause() } catch {}
  } catch (error) {
    out.error = String((error && error.stack) || error)
  }
  return out
})()`.replaceAll('__LYRIC_MOCK_URL__', lyricMockUrl)
}

/** Spawn the real Electron binary against the Vite dev server and capture the eval result. */
function runElectron(evalCode, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = {
      ...process.env,
      MP_DEV: '1',
      // Load the queue page so the track inspector (D-01 target) is mounted, matching the
      // page where a user actually sees the live queue.
      MP_SHOT_VIEW: 'queue',
      MP_EVAL: evalCode,
      MP_EVAL_WAIT: '2600',
      MP_SHOT_OUT: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electronPath, ['.', '--enable-logging=stderr', '--v=0'], {
      cwd: DESKTOP_ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (data) => (output += String(data)))
    child.stderr.on('data', (data) => (output += String(data)))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      const match = output.match(/\[eval\] result (.*)/)
      let result = null
      try {
        result = match ? JSON.parse(match[1]) : null
      } catch {
        result = null
      }
      resolve({ code, result, output })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, result: null, output: String(error?.message || error) })
    })
  })
}

/**
 * Local mock backend serving only the lyric endpoint for the D-13 race test.
 * `slow` answers after 350ms, `fast` immediately, `slowfail` returns 500 after 350ms.
 */
async function startLyricMock() {
  const server = http.createServer((request, response) => {
    const match = /^\/api\/music\/lyric\/[^/]+\/([^/?]+)/.exec(request.url || '')
    const musicId = match ? decodeURIComponent(match[1]) : ''
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (musicId === 'slow') {
      setTimeout(() => send(200, '[00:00.00]slow'), 350)
      return
    }
    if (musicId === 'slowfail') {
      setTimeout(() => send(500, { message: 'fixture lyric failure' }), 350)
      return
    }
    send(200, `[00:00.00]${musicId}`)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

function fatalErrorsInOutput(output) {
  const patterns = [
    /\[eval\] failed/,
    /Unhandled Rejection/i,
    /Uncaught Exception/i,
    /Cannot access 'filteredQueueView' before initialization/,
    /ReferenceError: Cannot access/
  ]
  return patterns.filter((pattern) => pattern.test(output)).map((pattern) => String(pattern))
}

async function main() {
  ensureDir(OUT_DIR)
  const collector = new Collector('electron-runtime', 'Electron 运行时：D-01/D-13/D-14/D-15/D-02/D-12', { label })

  if (await isPortListening(VITE_PORT)) {
    console.error(`端口 ${VITE_PORT} 已被占用，无法启动 Vite dev server`)
    process.exitCode = 1
    return
  }

  const viteServer = await createServer({
    root: DESKTOP_ROOT,
    configFile: path.join(DESKTOP_ROOT, 'vite.config.js'),
    server: { host: '127.0.0.1', port: VITE_PORT, strictPort: true },
    logLevel: 'error'
  })
  await viteServer.listen()
  const lyricMock = await startLyricMock()
  let run
  try {
    run = await runElectron(buildEvalCode(lyricMock.url))
  } finally {
    await lyricMock.close()
    await viteServer.close()
    await waitPortFree(VITE_PORT, 8000)
  }

  const result = run.result || {}
  const fatals = fatalErrorsInOutput(run.output)

  collector.expect('runtime-electron-eval-completed', {
    title: '真实 Electron 开发入口（Vite + 未打补丁 App.vue）执行渲染探针成功',
    expected: { appChildrenGte1: true, hasDebug: true, hasProtocolProbe: true },
    actual: {
      exitCode: run.code,
      appChildrenGte1: (result.boot?.appChildren ?? 0) >= 1,
      hasDebug: result.boot?.hasDebug,
      hasProtocolProbe: result.boot?.hasProtocolProbe,
      evalResultPresent: Boolean(run.result)
    },
    evidence: { boot: result.boot ?? null, fatals },
    level: 'real-electron'
  })
  collector.expect('d01-no-tdz-reference-error', {
    title: '运行日志中不再出现 filteredQueueView TDZ ReferenceError（D-01 根因）',
    expected: [],
    actual: fatals,
    level: 'real-electron'
  })

  const d01Add = result.d01Add || {}
  const addTitle = (d01Add.inspectorTitles || []).join(' ')
  collector.assert('d01-add-song-auto-selects-track-inspector', {
    title: '向实时队列加入歌曲后右侧自动选中曲目检查器（旧版停留在房间检查器）',
    expected: { filteredQueueCount: 1, inspectorIsTrack: true, trackTitleMatches: true },
    actual: {
      filteredQueueCount: d01Add.filteredQueueCount,
      inspectorTitles: d01Add.inspectorTitles,
      trackTitle: d01Add.trackTitle,
      inspectorIsTrack: /TRACK|曲目检查器/.test(addTitle),
      trackTitleMatches: (d01Add.trackTitle || '').includes('Runtime Audit')
    },
    condition: d01Add.filteredQueueCount === 1 && /TRACK|曲目检查器/.test(addTitle) && (d01Add.trackTitle || '').includes('Runtime Audit'),
    level: 'real-electron'
  })
  const d01Replace = result.d01Replace || {}
  collector.assert('d01-replace-queue-keeps-selection', {
    title: '替换队列后选中项保持有效（曲目检查器，仍为队列内歌曲）',
    expected: { filteredQueueCount: 2, inspectorIsTrack: true },
    actual: {
      filteredQueueCount: d01Replace.filteredQueueCount,
      inspectorTitles: d01Replace.inspectorTitles,
      trackTitle: d01Replace.trackTitle,
      inspectorIsTrack: /TRACK|曲目检查器/.test((d01Replace.inspectorTitles || []).join(' '))
    },
    condition:
      d01Replace.filteredQueueCount === 2 &&
      /TRACK|曲目检查器/.test((d01Replace.inspectorTitles || []).join(' ')) &&
      (d01Replace.trackTitle || '').length > 0,
    level: 'real-electron'
  })
  const d01Delete = result.d01DeleteCurrent || {}
  collector.assert('d01-delete-current-item-revalidates', {
    title: '删除当前选中项后不残留悬空选中（回退到剩余歌曲或房间检查器，无异常）',
    expected: { filteredQueueCount: 1, hasValidInspector: true },
    actual: {
      filteredQueueCount: d01Delete.filteredQueueCount,
      inspectorTitles: d01Delete.inspectorTitles,
      trackTitle: d01Delete.trackTitle,
      hasValidInspector: (d01Delete.inspectorTitles || []).length > 0
    },
    condition: d01Delete.filteredQueueCount === 1 && (d01Delete.inspectorTitles || []).length > 0,
    level: 'real-electron'
  })
  const d01Clear = result.d01Clear || {}
  collector.assert('d01-clear-queue-falls-back-to-room-inspector', {
    title: '清空队列后回退到房间检查器（不存在悬空选中）',
    expected: { filteredQueueCount: 0, inspectorIsRoom: true },
    actual: {
      filteredQueueCount: d01Clear.filteredQueueCount,
      inspectorTitles: d01Clear.inspectorTitles,
      inspectorIsRoom: /ROOM|房间检查器/.test((d01Clear.inspectorTitles || []).join(' '))
    },
    condition: d01Clear.filteredQueueCount === 0 && /ROOM|房间检查器/.test((d01Clear.inspectorTitles || []).join(' ')),
    level: 'real-electron'
  })

  collector.expect('d13-renderer-lyric-race', {
    title: '渲染进程内旧歌词晚返回不覆盖当前歌曲（显示 fast）',
    expected: 'fast',
    actual: result.d13Race?.displayed ?? null,
    evidence: { d13Race: result.d13Race ?? null },
    level: 'real-electron'
  })
  collector.expect('d13-renderer-stale-failure-keeps-lyrics', {
    title: '渲染进程内旧请求失败不清空新歌词（仍显示 fast）',
    expected: 'fast',
    actual: result.d13StaleFailure?.displayed ?? null,
    level: 'real-electron'
  })

  const guest = result.d15Guest || {}
  collector.assert('d15-renderer-guest-gate', {
    title: '渲染进程内游客点歌/聊天返回 {ok:false,code:GUEST}（界面据此提示而非假成功）',
    expected: { enqueueOkFalse: true, enqueueCode: 'GUEST', chatOkFalse: true, chatCode: 'GUEST' },
    actual: {
      enqueue: guest.enqueue ?? null,
      chat: guest.chat ?? null
    },
    condition:
      guest.enqueue?.ok === false &&
      guest.enqueue?.code === 'GUEST' &&
      guest.chat?.ok === false &&
      guest.chat?.code === 'GUEST',
    level: 'real-electron'
  })

  collector.expect('d02-renderer-normalization', {
    title: '渲染进程内地址规范化：裸域名 https、回环 http、无效地址空串',
    expected: { bare: 'https://music.example.com', loopback: 'http://127.0.0.1:8080', invalid: '', parseInvalid: false },
    actual: {
      bare: result.d02?.bare,
      loopback: result.d02?.loopback,
      invalid: result.d02?.invalid,
      parseInvalid: result.d02?.parseInvalid
    },
    level: 'real-electron'
  })
  collector.expect('d12-renderer-session-base', {
    title: '渲染进程内 sessionAddress/activeBase 保留完整 https+路径前缀，且不被 settings 新地址改变',
    expected: { sessionAddress: 'https://music.example.com/prefix', activeBase: 'https://music.example.com/prefix' },
    actual: { sessionAddress: result.d12?.sessionAddress, activeBase: result.d12?.activeBase },
    level: 'real-electron'
  })

  const d14 = result.d14 || {}
  collector.assert('d14-session-teardown-stops-audio', {
    title: '内部 leaveRoom（会话 teardown）后 engine.playing=false、nowPlaying/歌词/进度清理',
    expected: {
      beforePlaying: true,
      afterPlaying: false,
      afterJoined: false,
      afterNowPlayingNull: true,
      afterLyricsEmpty: true,
      afterProgressZero: true
    },
    actual: {
      before: d14.before ?? null,
      after: d14.after ?? null
    },
    condition:
      d14.before?.playing === true &&
      d14.after?.playing === false &&
      d14.after?.joined === false &&
      d14.after?.nowPlaying === null &&
      d14.after?.lyricCount === 0 &&
      d14.after?.progress === 0,
    evidence: { d14 },
    level: 'real-electron'
  })

  collector.assert('runtime-no-fatal-errors', {
    title: 'Electron 运行日志无未处理致命异常（[eval] failed / ReferenceError / Unhandled）',
    expected: [],
    actual: fatals,
    condition: fatals.length === 0,
    evidence: { evalError: result.error ?? null, outputTail: run.output.slice(-4000) },
    level: 'real-electron'
  })

  const payload = {
    env: {
      label,
      startedAt: nowIso(),
      node: process.version,
      electron: require('electron/package.json').version,
      platform: process.platform,
      entry: 'vite dev + electron (MP_DEV=1, MP_EVAL probe)',
      sourceModified: false
    },
    evalError: result.error ?? null,
    fatalPatterns: fatals,
    checks: collector.checks,
    summary: collector.summary()
  }
  const summaryFile = writeRunSummary(OUT_DIR, payload, DOCS_COPY)
  console.log(`\n${JSON.stringify(collector.summary())}\n${summaryFile}`)
  if (collector.summary().failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`[fatal] ${error?.stack || error}`)
  process.exitCode = 1
})

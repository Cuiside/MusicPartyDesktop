/**
 * Desktop client unit / static-source regression (D-01, D-02, D-06 client side, D-08,
 * D-12, D-13, D-15 client gate).
 *
 * By default the CURRENT `src/core/live/*` (and `src/App.vue`) is imported, i.e. the
 * in-progress fix. Pass `--desktop-baseline` to materialize the audited baseline commit
 * `8b4df500...` from git into a temp directory and run the exact same assertions against
 * the OLD code — those checks must FAIL (they prove the tests can detect the defects).
 *
 * Evidence levels: unit (pure functions / mocked HTTP) and static-source (App.vue /
 * transport.js ordering & wiring). No real server/Electron is used here.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { DESKTOP_ROOT, REGRESSION_ROOT, run as runCommand, sleep } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 'desktop-pure'
export const title = 'desktop 纯函数/静态回归：D-01/02/06/08/12/13/15（旧基线可对照）'

const BASELINE_COMMIT = '8b4df500662788a65c40d1ec9afb29cc688116f6'
const LIVE_FILES = ['config.js', 'admin.js', 'api.js', 'client.js', 'transport.js', 'state.js', 'mapping.js']

function moduleUrl(liveDir, file) {
  return pathToFileURL(path.join(liveDir, file)).href
}

async function materializeBaseline() {
  const dir = path.join(REGRESSION_ROOT, '.tmp-desktop-baseline')
  fs.rmSync(dir, { recursive: true, force: true })
  const files = [...LIVE_FILES.map((file) => `src/core/live/${file}`), 'src/App.vue']
  for (const rel of files) {
    const result = await runCommand('git', ['-C', DESKTOP_ROOT, 'show', `${BASELINE_COMMIT}:${rel}`])
    if (result.code !== 0) throw new Error(`git show ${BASELINE_COMMIT}:${rel} 失败：${result.stderr.slice(0, 300)}`)
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, result.stdout)
  }
  return dir
}

/** Start a tiny local HTTP server that records requests and delegates the response. */
async function startHttpMock(handler) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const record = {
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
        adminHeader: request.headers['x-admin-password'] || null,
        at: Date.now()
      }
      requests.push(record)
      try {
        handler(request, response, record)
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ message: String(error?.message || error) }))
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    withCredential: () => requests.filter((record) => record.adminHeader !== null),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}

export async function run(ctx) {
  const { collector } = ctx
  const baselineMode = Boolean(ctx.args?.['desktop-baseline'])
  let liveDir
  let appVuePath
  if (baselineMode) {
    const dir = await materializeBaseline()
    liveDir = path.join(dir, 'src/core/live')
    appVuePath = path.join(dir, 'src/App.vue')
  } else {
    liveDir = path.join(DESKTOP_ROOT, 'src/core/live')
    appVuePath = path.join(DESKTOP_ROOT, 'src/App.vue')
  }
  const modeLabel = baselineMode ? `旧基线 ${BASELINE_COMMIT.slice(0, 8)}` : '当前工作区源码'

  const config = await import(moduleUrl(liveDir, 'config.js'))

  // =========================== D-02: URL normalization =============================
  const normalize = (value) => {
    try {
      return config.normalizeServerUrl(value)
    } catch (error) {
      return `THREW:${error?.message || error}`
    }
  }
  collector.expect('d02-bare-public-domain-https', {
    title: '裸公网域名默认 https（旧版无条件补 http）',
    expected: 'https://music.example.com',
    actual: normalize('music.example.com'),
    level: LEVEL.UNIT
  })
  collector.expect('d02-explicit-https-preserved', {
    title: '显式 https 地址原样保留',
    expected: 'https://music.example.com/prefix',
    actual: normalize('https://music.example.com/prefix'),
    level: LEVEL.UNIT
  })
  collector.expect('d02-loopback-http', {
    title: '回环地址保留 http（本地服务）',
    expected: 'http://127.0.0.1:8080',
    actual: normalize('127.0.0.1:8080'),
    level: LEVEL.UNIT
  })
  collector.expect('d02-localhost-http', {
    title: 'localhost 保留 http',
    expected: 'http://localhost:8080',
    actual: normalize('localhost:8080'),
    level: LEVEL.UNIT
  })
  collector.expect('d02-private-lan-http', {
    title: '私网地址保留 http（LAN 本地服务）',
    expected: 'http://192.168.1.10:8080',
    actual: normalize('192.168.1.10:8080'),
    level: LEVEL.UNIT
  })
  collector.expect('d02-invalid-address-not-silent-localhost', {
    title: '无效地址不得静默回退 http://127.0.0.1:8080（返回空串明确失败）',
    expected: '',
    actual: normalize('%%%'),
    level: LEVEL.UNIT
  })
  collector.expect('d02-ws-url-path-prefix', {
    title: 'wsUrl 在路径前缀 base 后追加 /ws（REST/WS 同一 origin+prefix）',
    expected: 'wss://music.example.com/prefix/ws',
    actual: config.wsUrl('https://music.example.com/prefix'),
    level: LEVEL.UNIT
  })
  const parseServerUrl = typeof config.parseServerUrl === 'function' ? config.parseServerUrl : null
  const parsedInvalid = parseServerUrl ? parseServerUrl('%%%') : null
  collector.expect('d02-parse-server-url-explicit-error', {
    title: 'parseServerUrl("无效地址") 返回 {ok:false,error}，不静默回退',
    expected: { ok: false, hasErrorText: true },
    actual: parseServerUrl
      ? { ok: parsedInvalid?.ok, hasErrorText: typeof parsedInvalid?.error === 'string' && parsedInvalid.error.length > 0 }
      : 'missing export parseServerUrl',
    level: LEVEL.UNIT
  })
  const isPrivate = typeof config.isPrivateOrLoopbackHost === 'function' ? config.isPrivateOrLoopbackHost : null
  const privateHosts = ['127.0.0.1', 'localhost', '192.168.1.10', '10.0.0.5', '172.16.0.9']
  const publicHosts = ['music.example.com', '8.8.8.8']
  collector.expect('d02-private-host-classifier', {
    title: 'isPrivateOrLoopbackHost 正确区分回环/私网与公网域名',
    expected: { privateAllTrue: true, publicAllFalse: true },
    actual: isPrivate
      ? {
          privateAllTrue: privateHosts.every((host) => isPrivate(host) === true),
          publicAllFalse: publicHosts.every((host) => isPrivate(host) === false)
        }
      : 'missing export isPrivateOrLoopbackHost',
    evidence: isPrivate
      ? { privateResults: privateHosts.map((host) => isPrivate(host)), publicResults: publicHosts.map((host) => isPrivate(host)) }
      : null,
    level: LEVEL.UNIT
  })
  // Start from a known good value so "kept previous" is distinguishable from the default.
  config.saveSettings({ serverUrl: 'http://127.0.0.1:19999' })
  let invalidSaveThrew = false
  try {
    config.saveSettings({ serverUrl: '%%%' })
  } catch {
    invalidSaveThrew = true
  }
  const settingsAfterInvalid = config.loadSettings().serverUrl
  collector.assert('d02-settings-reject-invalid-address', {
    title: 'saveSettings 拒绝非法 serverUrl：保留上一个有效地址，不静默回退 localhost',
    expected: { previousServerUrlKept: true, notSilentLocalhostFallback: true },
    actual: {
      threw: invalidSaveThrew,
      serverUrlAfter: settingsAfterInvalid,
      previousServerUrlKept: settingsAfterInvalid === 'http://127.0.0.1:19999',
      notSilentLocalhostFallback: settingsAfterInvalid !== 'http://127.0.0.1:8080'
    },
    condition: settingsAfterInvalid === 'http://127.0.0.1:19999',
    level: LEVEL.UNIT
  })

  // =========================== D-12 / D-16: session base ===========================
  let sessionModule = null
  try {
    sessionModule = await import(moduleUrl(liveDir, 'session.js'))
  } catch {
    sessionModule = null
  }
  const sessionApi = sessionModule
    ? {
        beginSession: sessionModule.beginSession,
        endSession: sessionModule.endSession,
        activeBase: sessionModule.activeBase,
        sessionAddress: sessionModule.sessionAddress
      }
    : null
  collector.expect('d12-session-module-contract', {
    title: 'session.js 提供 beginSession/endSession/activeBase/sessionAddress（不可变 session base）',
    expected: { exists: true, exports: true },
    actual: sessionApi
      ? {
          exists: true,
          exports:
            typeof sessionApi.beginSession === 'function' &&
            typeof sessionApi.endSession === 'function' &&
            typeof sessionApi.activeBase === 'function' &&
            typeof sessionApi.sessionAddress === 'function'
        }
      : { exists: false, exports: false },
    level: LEVEL.UNIT
  })
  if (sessionApi && typeof sessionApi.beginSession === 'function') {
    config.saveSettings({ serverUrl: 'http://127.0.0.1:18848' })
    sessionApi.beginSession('http://127.0.0.1:18848')
    config.saveSettings({ serverUrl: 'http://127.0.0.1:18849' })
    collector.expect('d16-settings-do-not-change-active-session-base', {
      title: '保存新地址不改变当前已连接 session base（D-16 编辑地址/当前会话分离）',
      expected: 'http://127.0.0.1:18848',
      actual: sessionApi.activeBase(),
      level: LEVEL.UNIT
    })
    sessionApi.beginSession('https://music.example.com/prefix')
    collector.expect('d12-session-address-keeps-scheme-and-prefix', {
      title: '复制/展示地址使用完整 session base（含 https 与路径前缀，不从 host 逆推）',
      expected: 'https://music.example.com/prefix',
      actual: sessionApi.sessionAddress(),
      level: LEVEL.UNIT
    })
    sessionApi.endSession()
    config.saveSettings({ serverUrl: 'http://127.0.0.1:18849' })
    collector.expect('d16-end-session-falls-back-to-settings', {
      title: 'endSession 后 activeBase 回退到下次连接地址（settings）',
      expected: 'http://127.0.0.1:18849',
      actual: sessionApi.activeBase(),
      level: LEVEL.UNIT
    })
  } else {
    collector.skip('d16-session-base-behaviour', {
      title: 'session base 行为（保存新地址不影响当前会话）',
      expected: '不可变 session base 行为',
      reason: '当前源码缺少 session.js（旧基线预期）：该组断言在旧代码上必然 FAIL，已由 d12-session-module-contract 覆盖。',
      level: LEVEL.UNIT
    })
  }

  // =========================== D-08: admin credential binding ======================
  const admin = await import(moduleUrl(liveDir, 'admin.js'))
  const serverB = await startHttpMock((request, response) => json(response, 403, { message: 'ACCESS DENIED' }))
  const serverA = await startHttpMock((request, response) => {
    if (request.method === 'POST' && request.url.startsWith('/api/admin/verify')) {
      return json(response, 200, { message: 'VERIFIED' })
    }
    if (request.url.startsWith('/api/admin/redirect')) {
      response.writeHead(302, { Location: serverB.url + '/api/admin/steal-admin-header' })
      return response.end()
    }
    return json(response, 200, { message: 'OK' })
  })
  ctx.onCleanup(async () => {
    await serverA.close()
    await serverB.close()
  })

  config.saveSettings({ serverUrl: serverA.url })
  const verifiedOnA = await admin.verifyAdmin('fixture-admin-origin-a')
  config.saveSettings({ serverUrl: serverB.url })
  let crossOriginError = null
  try {
    await admin.adminRequest('POST', '/api/admin/room/stream', { enabled: false })
  } catch (error) {
    crossOriginError = String(error?.message || error)
  }
  collector.assert('d08-admin-credential-not-sent-to-new-origin', {
    title: 'A 认证后切换到 B：B 不得收到 A 的管理员密码（请求必须拒绝）',
    expected: { verifiedOnA: true, credentialSentToB: false, requestRejected: true },
    actual: {
      verifiedOnA,
      credentialSentToB: serverB.withCredential().length > 0,
      requestRejected: Boolean(crossOriginError),
      error: crossOriginError
    },
    condition: verifiedOnA === true && serverB.withCredential().length === 0 && Boolean(crossOriginError),
    evidence: { bRequests: serverB.requests.length, bCredentialRequests: serverB.withCredential().length },
    level: LEVEL.UNIT
  })

  // Same origin, different path prefix = a different backend base → must re-verify.
  config.saveSettings({ serverUrl: serverA.url })
  await admin.verifyAdmin('fixture-admin-origin-a')
  config.saveSettings({ serverUrl: `${serverA.url}/prefix` })
  let prefixSwitchError = null
  const credentialCountBeforeRequest = serverA.withCredential().length
  try {
    await admin.adminRequest('POST', '/api/admin/room/stream', { enabled: false })
  } catch (error) {
    prefixSwitchError = String(error?.message || error)
  }
  const credentialCountAfterRequest = serverA.withCredential().length
  collector.assert('d08-same-origin-different-prefix-rejected', {
    title: '同域不同路径前缀视为不同服务器：不得携带旧凭据发送',
    expected: { rejected: true, credentialSentAfterSwitch: false },
    actual: {
      rejected: Boolean(prefixSwitchError),
      credentialSentAfterSwitch: credentialCountAfterRequest > credentialCountBeforeRequest,
      error: prefixSwitchError
    },
    condition: Boolean(prefixSwitchError) && credentialCountAfterRequest === credentialCountBeforeRequest,
    evidence: { credentialRequestsAfterSwitch: credentialCountAfterRequest - credentialCountBeforeRequest },
    level: LEVEL.UNIT
  })

  // Cross-origin redirect must not forward the admin header.
  config.saveSettings({ serverUrl: serverA.url })
  await admin.verifyAdmin('fixture-admin-origin-a')
  const bCredentialBeforeRedirect = serverB.withCredential().length
  let redirectError = null
  try {
    await admin.adminRequest('POST', '/api/admin/redirect-check', {})
  } catch (error) {
    redirectError = String(error?.message || error)
  }
  await sleep(150)
  collector.assert('d08-cross-origin-redirect-does-not-leak-credential', {
    title: '管理请求跨源 302 重定向时不得把 X-Admin-Password 带到新源',
    expected: { bReceivedCredential: false },
    actual: {
      bReceivedCredential: serverB.withCredential().length > bCredentialBeforeRedirect,
      redirectError
    },
    condition: serverB.withCredential().length === bCredentialBeforeRedirect,
    evidence: { redirectError },
    level: LEVEL.UNIT
  })
  admin.adminLogout()

  // =========================== D-13: lyric request race ============================
  const lyricMock = await startHttpMock((request, response) => {
    const match = /^\/api\/music\/lyric\/[^/]+\/(.+)$/.exec(request.url)
    const musicId = match ? decodeURIComponent(match[1].split('?')[0]) : ''
    if (musicId === 'slow') {
      setTimeout(() => json(response, 200, '[00:00.00]slow'), 350)
      return
    }
    if (musicId === 'slowfail') {
      setTimeout(() => json(response, 500, { message: 'fixture lyric failure' }), 350)
      return
    }
    json(response, 200, `[00:00.00]${musicId}`)
  })
  ctx.onCleanup(() => lyricMock.close())
  config.saveSettings({ serverUrl: lyricMock.url })
  const liveState = (await import(moduleUrl(liveDir, 'state.js'))).live
  const api = await import(moduleUrl(liveDir, 'api.js'))

  liveState.lyrics = []
  liveState.nowPlaying = { id: 'slow', source: 'netease' }
  const slowLyrics = api.fetchLyrics({ id: 'slow', source: 'netease' })
  await sleep(60)
  liveState.nowPlaying = { id: 'fast', source: 'netease' }
  const fastLyrics = api.fetchLyrics({ id: 'fast', source: 'netease' })
  await Promise.allSettled([slowLyrics, fastLyrics])
  await sleep(250)
  collector.expect('d13-late-old-lyric-does-not-overwrite', {
    title: '旧歌词请求晚返回不得覆盖当前歌曲歌词（先 slow 后 fast → 显示 fast）',
    expected: 'fast',
    actual: liveState.lyrics?.[0]?.text ?? null,
    evidence: { lyrics: liveState.lyrics?.slice(0, 3) ?? null },
    level: LEVEL.UNIT
  })

  liveState.lyrics = []
  liveState.nowPlaying = { id: 'fast', source: 'netease' }
  const failingOldLyrics = api.fetchLyrics({ id: 'slowfail', source: 'netease' })
  await sleep(60)
  const winningLyrics = api.fetchLyrics({ id: 'fast', source: 'netease' })
  await Promise.allSettled([failingOldLyrics, winningLyrics])
  await sleep(250)
  collector.expect('d13-late-old-failure-does-not-clear', {
    title: '旧歌词请求失败晚返回不得清空当前已显示歌词（先失败后成功 → 仍显示 fast）',
    expected: 'fast',
    actual: liveState.lyrics?.[0]?.text ?? null,
    level: LEVEL.UNIT
  })

  // =========================== D-15: client-side guest gate ========================
  const client = await import(moduleUrl(liveDir, 'client.js'))
  liveState.identity = { id: 'fixture-guest-public-id', name: '游客', isGuest: true, token: 'fixture-guest-token' }
  liveState.connected = true
  const guestEnqueue = await client.addToQueue({ id: 'fixture-unit-track', source: 'netease' })
  const guestChat = await client.sendChat('fixture unit guest chat')
  const normalizedGuest = (result) =>
    result && typeof result === 'object'
      ? { isObject: true, ok: result.ok, code: result.code, confirmed: result.confirmed }
      : { isObject: false, type: typeof result, value: result }
  collector.expect('d15-client-guest-gate-enqueue', {
    title: '游客客户端 addToQueue 本地即返回 {ok:false,code:GUEST}（不发命令、不假成功）',
    expected: { isObject: true, ok: false, code: 'GUEST', confirmed: false },
    actual: normalizedGuest(guestEnqueue),
    level: LEVEL.UNIT
  })
  collector.expect('d15-client-guest-gate-chat', {
    title: '游客客户端 sendChat 本地即返回 {ok:false,code:GUEST}',
    expected: { isObject: true, ok: false, code: 'GUEST', confirmed: false },
    actual: normalizedGuest(guestChat),
    level: LEVEL.UNIT
  })
  liveState.identity = { id: 'fixture-member-public-id', name: 'MemberUnit', isGuest: false, token: 'fixture-member-token' }
  liveState.connected = false
  const offlineEnqueue = await client.addToQueue({ id: 'fixture-unit-track', source: 'netease' })
  collector.expect('d15-client-offline-code', {
    title: '断开时命令返回 {ok:false,code:OFFLINE}，不冒充成功',
    expected: { isObject: true, ok: false, code: 'OFFLINE', confirmed: false },
    actual: normalizedGuest(offlineEnqueue),
    level: LEVEL.UNIT
  })

  // =========================== D-01: App.vue watch ordering ========================
  const appVueText = fs.readFileSync(appVuePath, 'utf8')
  const computedIndex = appVueText.indexOf('const filteredQueueView = computed(')
  // The watcher that computes the filtered selection signature; its first execution must
  // happen only after filteredQueueView is initialized (TDZ fix). The baseline file has it
  // at ~line 959, i.e. BEFORE the computed at ~line 1073.
  const watcherExprIndex = appVueText.indexOf('filteredQueueView.value.map((s) => s.id)')
  collector.assert('d01-filteredqueueview-watch-after-init', {
    title: 'App.vue 中 filteredQueueView watch 位于 computed 初始化之后（消除 TDZ ReferenceError）',
    expected: { bothFound: true, watchAfterComputed: true },
    actual: { computedIndex, watcherExprIndex, bothFound: computedIndex >= 0 && watcherExprIndex >= 0 },
    condition: computedIndex >= 0 && watcherExprIndex >= 0 && watcherExprIndex > computedIndex,
    evidence: { appVuePath, modeLabel },
    level: LEVEL.STATIC
  })

  // =========================== D-06: client transport wiring =======================
  const transportText = fs.readFileSync(path.join(liveDir, 'transport.js'), 'utf8')
  const hasPingDestination = /['"]\/app\/ping['"]/.test(transportText)
  const legacyResyncLatency = /latencyTimer\s*=\s*setInterval\(\s*measureLatency/.test(transportText)
  const legacyResyncInsideMeasure = /function measureLatency\s*\([^)]*\)\s*\{[\s\S]{0,500}DEST\.resync/.test(transportText)
  collector.assert('d06-client-ping-not-resync-rtt', {
    title: 'transport.js 使用 /app/ping 测 RTT，删除 30s resync 广播测延迟；resync 仅显式快照',
    expected: { hasPingDestination: true, periodicResyncLatencyRemoved: true, measureLatencyNoResync: true },
    actual: {
      hasPingDestination,
      legacyResyncLatency,
      legacyResyncInsideMeasure,
      periodicResyncLatencyRemoved: legacyResyncLatency === false,
      measureLatencyNoResync: legacyResyncInsideMeasure === false
    },
    condition: hasPingDestination && !legacyResyncLatency && !legacyResyncInsideMeasure,
    level: LEVEL.STATIC
  })

  // =========================== D-14: covered in real Electron suite ================
  collector.skip('d14-session-teardown-audio', {
    title: '内部 leaveRoom/会话 teardown 后 engine.playing=false',
    expected: '真实 AudioContext 下暂停并清 source/歌词/同步锚点',
    reason: 'Node 环境无 AudioContext；该项在真实 Electron 运行时套件（tests/runtime）中用合成 WAV 验证，本单元层不声称通过。',
    level: LEVEL.UNIT
  })
}

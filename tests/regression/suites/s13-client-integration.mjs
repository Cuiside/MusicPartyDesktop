/**
 * Desktop client × real server integration ("protocol v2 client").
 *
 * Uses the CURRENT `src/core/live` modules (the in-progress new client) against the real
 * JAR under test. Two purposes:
 *  1. New server: the client must obtain session base/capabilities/ACK/ping and report
 *     confirmed command results.
 *  2. Old server (baseline JAR): the SAME new client must degrade gracefully — no
 *     command-ack capability → `{ok:true, confirmed:false, code:'UNCONFIRMED'}` with the
 *     legacy fire-and-forget behavior, no ping capability → HTTP latency fallback, no
 *     crash. This is the deployment compatibility matrix, not a server fix claim.
 *
 * D-16 isolation: after joining server A, saving a different address in settings must not
 * move REST traffic or the active session base until an explicit switch/reconnect.
 */
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { get } from '../lib/http.mjs'
import { DESKTOP_ROOT, SECOND_SERVER_PORT, sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's13-client-integration'
export const title = '桌面客户端 × 真实 JAR 集成：协议 v2 正常路径 + 旧服务端降级 + 双服务器隔离'

const ADMIN = 'fixture-admin-s13'
const FAKE_B_PORT = SECOND_SERVER_PORT

function moduleUrl(file) {
  return pathToFileURL(path.join(DESKTOP_ROOT, 'src/core/live', file)).href
}

async function startFakeServer(port) {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, at: Date.now() })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify([]))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

function normalizedResult(result) {
  if (result && typeof result === 'object') {
    return {
      isObject: true,
      ok: result.ok,
      confirmed: result.confirmed,
      code: result.code,
      reason: result.reason ?? null
    }
  }
  return { isObject: false, type: typeof result, value: result }
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())
  const server = await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir('s13'),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))
  const fakeB = await startFakeServer(FAKE_B_PORT)
  ctx.onCleanup(() => fakeB.close())

  const config = await import(moduleUrl('config.js'))
  const state = (await import(moduleUrl('state.js'))).live
  const client = await import(moduleUrl('client.js'))

  const capabilityResponse = await get(server.base, '/api/config')
  const capabilities = Array.isArray(capabilityResponse.json?.capabilities) ? capabilityResponse.json.capabilities : []
  const serverVersion = String(capabilityResponse.json?.serverVersion || 'unknown')
  const supportsAck = capabilities.includes('command-ack')
  const supportsPing = capabilities.includes('ping')
  const supportsIdentityV2 = capabilities.includes('identity-v2')
  // Distinguish "new server" from "deployed 1.3.9 baseline" without hardcoding the JAR.
  const isNewProtocolServer = capabilities.length > 0

  // ================= join + session base ===========================================
  config.saveSettings({ serverUrl: server.base })
  const joined = await client.joinRoom({ serverUrl: server.base, name: 'ClientIntegration', password: '' })
  await sleep(500)
  collector.expect('s13-join-room', {
    title: '新客户端 joinRoom 连接真实 JAR 成功',
    expected: true,
    actual: joined,
    evidence: { serverVersion, capabilities },
    level: LEVEL.REAL_JAR
  })
  const currentBase = typeof client.currentSessionBase === 'function' ? client.currentSessionBase() : undefined
  collector.expect('s13-session-base-established', {
    title: 'joinRoom 后 currentSessionBase() 等于实际连接地址（不可变 session base）',
    expected: server.base,
    actual: currentBase,
    evidence: { stateServer: state.server },
    level: LEVEL.REAL_JAR
  })

  // ================= member enqueue through the new client =========================
  upstream.reset()
  const enqueueResult = await client.addToQueue({ id: 'full', source: 'netease' })
  await sleep(1200)
  const nowPlayingId = state.nowPlaying?.id ?? null
  const expectedEnqueue = supportsAck
    ? { ok: true, confirmed: true, code: 'OK' }
    : { ok: true, confirmed: false, code: 'UNCONFIRMED' }
  const enqueueNormalized = normalizedResult(enqueueResult)
  collector.expect('s13-client-enqueue-capability-aware', {
    title: supportsAck
      ? '新服务端 command-ack 能力：点歌返回 confirmed=true code=OK 且歌曲实际播放'
      : '旧服务端降级：点歌返回 {ok:true,confirmed:false,code:UNCONFIRMED}（不假成功），歌曲仍通过旧路径播放',
    expected: expectedEnqueue,
    actual: {
      ok: enqueueNormalized.ok,
      confirmed: enqueueNormalized.confirmed,
      code: enqueueNormalized.code
    },
    evidence: {
      capabilityResponse: capabilityResponse.json,
      nowPlayingId,
      played: nowPlayingId === 'full',
      upstreamPaths: upstream.records.map((r) => r.path),
      reason: enqueueNormalized.reason
    },
    condition:
      enqueueNormalized.ok === expectedEnqueue.ok &&
      enqueueNormalized.confirmed === expectedEnqueue.confirmed &&
      enqueueNormalized.code === expectedEnqueue.code &&
      nowPlayingId === 'full',
    level: LEVEL.REAL_JAR
  })

  // ================= guest client-side gate =======================================
  // NOTE: a real client keeps its recovery key across leaveRoom (same device identity),
  // so re-joining with a guest nickname may legitimately restore the member identity. The
  // guest gate is therefore asserted on the authoritative identity state (same code path
  // the UI uses), which is what blocks the command locally.
  await client.leaveRoom()
  await sleep(200)
  state.identity = { id: 'fixture-s13-guest', name: '游客', isGuest: true }
  state.connected = true
  const guestChat = await client.sendChat('fixture client guest chat')
  const guestAfterState = { isGuest: state.identity?.isGuest }
  collector.expect('s13-client-guest-gate-real-server', {
    title: '游客身份下 sendChat 由客户端本地门禁拦截：{ok:false,code:GUEST}（不发命令）',
    expected: { isObject: true, ok: false, code: 'GUEST' },
    actual: {
      isObject: normalizedResult(guestChat).isObject,
      ok: normalizedResult(guestChat).ok,
      code: normalizedResult(guestChat).code
    },
    evidence: { identity: state.identity ?? null, guestAfterState },
    level: LEVEL.REAL_JAR
  })
  state.identity = null
  state.connected = false
  await sleep(200)

  // ================= member chat (capability aware) ================================
  config.saveSettings({ serverUrl: server.base })
  await client.joinRoom({ serverUrl: server.base, name: 'ClientMember', password: '' })
  await sleep(1400) // clear the server-side min chat/control cooldown from prior commands
  const chatResult = await client.sendChat(`fixture client chat ${Date.now()}`)
  const expectedChat = supportsAck
    ? { ok: true, confirmed: true, code: 'OK' }
    : { ok: true, confirmed: false, code: 'UNCONFIRMED' }
  const chatNormalized = normalizedResult(chatResult)
  collector.expect('s13-client-chat-capability-aware', {
    title: supportsAck ? '成员聊天返回 confirmed=true code=OK' : '旧服务端降级聊天返回 UNCONFIRMED（已发送未确认）',
    expected: expectedChat,
    actual: {
      ok: chatNormalized.ok,
      confirmed: chatNormalized.confirmed,
      code: chatNormalized.code
    },
    evidence: { reason: chatNormalized.reason, message: chatNormalized.message },
    level: LEVEL.REAL_JAR
  })

  // ================= D-16: settings change must not move the live session ===========
  const isolationKeyword = `isolation-probe-${Date.now()}`
  upstream.reset()
  const fakeRequestsBefore = fakeB.requests.length
  config.saveSettings({ serverUrl: fakeB.url })
  let searchError = null
  try {
    await client.search('netease', isolationKeyword)
  } catch (error) {
    searchError = String(error?.message || error)
  }
  await sleep(300)
  const upstreamSawKeyword = upstream.records.some((record) =>
    Object.values(record.params || {}).some((value) => String(value).includes(isolationKeyword))
  )
  const fakeBReceivedSearch = fakeB.requests
    .slice(fakeRequestsBefore)
    .some((record) => record.url.includes('/api/search'))
  const activeBaseAfter = typeof client.currentSessionBase === 'function' ? client.currentSessionBase() : undefined
  collector.assert('d16-settings-change-keeps-live-session', {
    title: '已连接 A 时保存 B 地址：搜索仍发往当前 session base A（不串服务器），B 不收到请求',
    expected: { activeBaseStillA: true, upstreamSawSearch: true, fakeBReceivedSearch: false },
    actual: {
      activeBaseStillA: activeBaseAfter === server.base,
      upstreamSawKeyword,
      fakeBReceivedSearch,
      fakeBRequests: fakeB.requests.slice(fakeRequestsBefore).map((record) => record.url),
      searchError
    },
    condition: activeBaseAfter === server.base && upstreamSawKeyword && !fakeBReceivedSearch,
    evidence: { isolationKeyword, searchError },
    level: LEVEL.REAL_JAR
  })

  collector.assert('s13-client-capabilities-detected', {
    title: '客户端从 /api/config 探测能力（新服务端含 ping/command-ack/identity-v2；旧服务端为空能力列表）',
    expected: {
      pingMatches: true,
      ackMatches: true,
      identityMatches: true
    },
    actual: {
      isNewProtocolServer,
      supportsPing,
      supportsAck,
      supportsIdentityV2,
      pingMatches: isNewProtocolServer === supportsPing,
      ackMatches: isNewProtocolServer === supportsAck,
      identityMatches: isNewProtocolServer === supportsIdentityV2,
      capabilities
    },
    condition: isNewProtocolServer === supportsPing && isNewProtocolServer === supportsAck && isNewProtocolServer === supportsIdentityV2,
    level: LEVEL.REAL_JAR
  })

  await client.leaveRoom()
  await server.stop({ graceMs: 0 })
}

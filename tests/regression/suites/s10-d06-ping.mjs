/**
 * D-06 — point-to-point ping/pong with requestId (replaces periodic resync RTT).
 *
 * Expected behavior: PROTOCOL_V2.md §5. A ping must be answered by a UNICAST pong to the
 * requesting session only; other clients in the room must never see it.
 *
 * Baseline on the deployed 1.3.9 JAR must FAIL (no /app/ping handler → no pong, and the
 * 30s resync measurement is a whole-room broadcast).
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { connectStomp } from '../lib/stomp.mjs'
import { get, waitForValue } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's10-d06-ping'
export const title = 'D-06 协议 ping/pong：requestId 单播、房间内其他客户端不收到 pong'

const ADMIN = 'fixture-admin-d06'

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())
  const server = await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir('d06'),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))

  const config = (await get(server.base, '/api/config')).json || {}
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities : []
  collector.assert('d06-ping-capability', {
    title: '/api/config capabilities 包含 ping（客户端据此启用 ping 探测）',
    expected: true,
    actual: capabilities.includes('ping'),
    condition: capabilities.includes('ping'),
    evidence: { capabilities },
    level: LEVEL.REAL_JAR
  })

  const alpha = await connectStomp({ baseUrl: server.base, headers: { 'user-name': 'PingAlpha', 'room-password': '' }, label: 'ping-alpha' })
  const beta = await connectStomp({ baseUrl: server.base, headers: { 'user-name': 'PingBeta', 'room-password': '' }, label: 'ping-beta' })
  await sleep(200)

  const requestId = `fixture-ping-${Date.now()}`
  const clientTime = Date.now()
  alpha.send('/app/ping', { requestId, clientTime })

  const pong = await alpha.waitJson('/user/queue/pong', (json) => json?.requestId === requestId, 3500)
  collector.expect('d06-ping-pong-unicast', {
    title: 'SEND /app/ping {requestId,clientTime} → 本人收到 /user/queue/pong 同 requestId/clientTime + serverTime',
    expected: { received: true, requestIdEcho: true, clientTimeEcho: true, serverTimeNumber: true },
    actual: {
      received: Boolean(pong),
      requestIdEcho: pong?.requestId === requestId,
      clientTimeEcho: pong?.clientTime === clientTime,
      serverTimeNumber: typeof pong?.serverTime === 'number' && pong.serverTime > 0
    },
    evidence: { pong: pong ?? null },
    level: LEVEL.REAL_JAR
  })

  // Give the second client ample time to (wrongly) receive a broadcast pong.
  await sleep(900)
  const betaPongs = beta.count('/user/queue/pong', (json) => json?.requestId === requestId)
  collector.expect('d06-pong-not-broadcast', {
    title: '房间内其他客户端不得收到该 requestId 的 pong（单播，不是 /topic 广播）',
    expected: 0,
    actual: betaPongs,
    level: LEVEL.REAL_JAR
  })

  // A ping must not trigger a full player-state broadcast to the room.
  const statesBefore = beta.messages('/topic/player/state').length
  alpha.send('/app/ping', { requestId: `fixture-ping-2-${Date.now()}`, clientTime: Date.now() })
  await sleep(600)
  const statesAfter = beta.messages('/topic/player/state').length
  collector.expect('d06-ping-does-not-broadcast-state', {
    title: 'ping 不应触发全房间 PlayerState 广播',
    expected: statesBefore,
    actual: statesAfter,
    evidence: { statesBefore, statesAfter },
    level: LEVEL.REAL_JAR
  })

  // 30s resync RTT: the client must not use resync periodically. This is asserted on the
  // desktop client source in the desktop suite; here we only guard that explicit resync
  // still delivers a snapshot (old clients depend on it).
  const statesBeforeResync = alpha.messages('/topic/player/state').length
  alpha.send('/app/player/resync', {})
  const freshState = await waitForValue(
    () => (alpha.messages('/topic/player/state').length > statesBeforeResync ? alpha.lastJson('/topic/player/state') : null),
    { timeoutMs: 3000, intervalMs: 80 }
  )
  collector.assert('d06-explicit-resync-still-works', {
    title: '显式 resync 仍返回完整快照（旧客户端兼容；仅不得用于周期 RTT）',
    expected: { freshStateReceived: true, onlineUsersPresent: true },
    actual: {
      freshStateReceived: Boolean(freshState),
      stateFrames: alpha.messages('/topic/player/state').length,
      onlineUsersPresent: Array.isArray(freshState?.onlineUsers)
    },
    condition: Boolean(freshState) && Array.isArray(freshState?.onlineUsers),
    level: LEVEL.REAL_JAR
  })

  await Promise.all([alpha.disconnect(), beta.disconnect()])
  await server.stop({ graceMs: 0 })
}

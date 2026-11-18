/**
 * S-09 — auth rate limiting on HTTP verify and STOMP CONNECT, with X-Forwarded-For
 * trust hardening.
 *
 * Expected behavior: PROTOCOL_V2.md + BUGREPORT S-09. 5 failed attempts (config default)
 * on HTTP verify block the direct client IP; rotating a client-supplied X-Forwarded-For
 * must NOT reset the counter unless a trusted proxy chain is configured. The STOMP
 * CONNECT password check must share the same limiter so brute forcing over WebSocket is
 * not an unlimited bypass.
 *
 * Baseline on the deployed 1.3.9 JAR: HTTP limiter trusts the first XFF value (spoofable)
 * and STOMP CONNECT has no limiting at all → checks FAIL.
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { tryConnectStomp } from '../lib/stomp.mjs'
import { adminRequest, post, request } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's09-ratelimit'
export const title = 'S-09 认证限流：HTTP verify 429、XFF 伪造不可绕过、WS CONNECT 共享限流'

const ADMIN = 'fixture-admin-s09'
const ROOM_PASSWORD = 'fixture-room-pass-20261110'
const MAX_ATTEMPTS = 5

async function makeServer(ctx, name) {
  return await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir(name),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())

  // ================= Part 1: HTTP verify + spoofed XFF ==============================
  let server = await makeServer(ctx, 's09-http')
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))
  try {
    await post(server.base, '/api/auth/setup', { password: ROOM_PASSWORD })

    // Rotate X-Forwarded-For on every attempt; an untrusted client header must not
    // create a fresh per-IP bucket.
    let lastResponse = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS + 1; attempt++) {
      lastResponse = await request(server.base, '/api/auth/verify', {
        method: 'POST',
        body: { password: `fixture-wrong-${attempt}` },
        headers: { 'X-Forwarded-For': `198.51.100.${attempt}` }
      })
      if (attempt <= MAX_ATTEMPTS) {
        collector.add({
          id: `s09-http-attempt-${attempt}`,
          title: `第 ${attempt} 次错误密码（伪造不同 XFF）返回 401`,
          expected: 401,
          actual: lastResponse.status,
          pass: lastResponse.status === 401,
          level: LEVEL.REAL_JAR
        })
      }
    }
    collector.expect('s09-http-rate-limited-429', {
      title: `连续 ${MAX_ATTEMPTS} 次失败后，rotate X-Forwarded-For 仍返回 429（不信任客户端 XFF）`,
      expected: 429,
      actual: lastResponse.status,
      evidence: { body: lastResponse.text.slice(0, 400), headers: lastResponse.headers },
      level: LEVEL.REAL_JAR
    })
    const blockedCorrect = await post(server.base, '/api/auth/verify', { password: ROOM_PASSWORD })
    collector.expect('s09-blocked-even-with-correct-password', {
      title: '封锁期间即使密码正确也返回 429（限流生效）',
      expected: 429,
      actual: blockedCorrect.status,
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }

  // ================= Part 2: STOMP CONNECT password brute force =====================
  server = await makeServer(ctx, 's09-ws')
  try {
    await post(server.base, '/api/auth/setup', { password: ROOM_PASSWORD })
    await sleep(200)
    let wrongFailures = 0
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await tryConnectStomp({
        baseUrl: server.base,
        headers: { 'user-name': `WbBrute${attempt}`, 'room-password': `fixture-wrong-${attempt}` },
        subscriptions: [],
        label: `ws-wrong-${attempt}`
      })
      if (!result.ok) wrongFailures++
      else await result.handle.disconnect()
    }
    collector.expect('s09-ws-wrong-password-refused', {
      title: 'WS CONNECT 错误房间密码被拒绝（基线前提）',
      expected: MAX_ATTEMPTS,
      actual: wrongFailures,
      level: LEVEL.REAL_JAR
    })
    const afterBrute = await tryConnectStomp({
      baseUrl: server.base,
      headers: { 'user-name': 'WbBruteCorrect', 'room-password': ROOM_PASSWORD },
      subscriptions: [],
      label: 'ws-correct-after-brute'
    })
    if (afterBrute.ok) await afterBrute.handle.disconnect()
    collector.assert('s09-ws-connect-rate-limited', {
      title: 'WS CONNECT 与 HTTP 共享失败计数：连续错误密码后，正确密码也被限流拒绝',
      expected: { correctConnectRefused: true },
      actual: { correctConnectAccepted: afterBrute.ok, error: afterBrute.error || null },
      condition: afterBrute.ok === false,
      evidence: { bruteFailures: wrongFailures, error: afterBrute.error || null },
      level: LEVEL.REAL_JAR
    })
    collector.skip('s09-ws-xff-spoof', {
      title: 'WS CONNECT 无法携带 X-Forwarded-For，代理信任仅影响 HTTP 路径',
      expected: 'WS 直连 IP 不可伪造',
      reason: 'STOMP CONNECT 帧没有 XFF 语义；该维度只适用于 HTTP verify（已在 Part 1 覆盖）。',
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }
}

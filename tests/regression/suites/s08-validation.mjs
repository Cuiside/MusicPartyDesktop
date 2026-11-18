/**
 * S-08 — input validation, HTTP status semantics and side-effect safety.
 *
 * Expected behavior: PROTOCOL_V2.md general + BUGREPORT S-08 (400/405 instead of 500,
 * unknown enum rejected with zero side effects, no internal Java details in messages).
 * Baseline on the deployed 1.3.9 JAR must FAIL on several checks.
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { connectStomp } from '../lib/stomp.mjs'
import { adminRequest, get, leaksInternalDetail, waitForValue } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's08-validation'
export const title = 'S-08 输入校验与 HTTP 语义：400/405、未知枚举零副作用、无内部细节泄漏'

const ADMIN = 'fixture-admin-s08'

async function connectMember(baseUrl, name) {
  const stomp = await connectStomp({ baseUrl, headers: { 'user-name': name, 'room-password': '' }, label: name })
  stomp.send('/app/user/rename', { newName: name })
  await stomp.waitJson('/user/queue/me', (json) => json?.name === name && json?.isGuest === false, 5000)
  return stomp
}

async function snapshot(stomp, timeoutMs = 4000) {
  const before = stomp.messages('/topic/player/state').length
  stomp.send('/app/player/resync', {})
  const fresh = await waitForValue(
    () => (stomp.messages('/topic/player/state').length > before ? stomp.lastJson('/topic/player/state') : null),
    { timeoutMs, intervalMs: 100 }
  )
  return fresh || stomp.lastJson('/topic/player/state') || {}
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())
  const server = await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir('s08'),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))
  const admin = (path, body) => adminRequest(server.base, path, body, { password: ADMIN })

  // ---- 1. Wrong HTTP method must be 405, not 500 -----------------------------------
  const getAuthVerify = await get(server.base, '/api/auth/verify')
  collector.expect('s08-get-on-post-only-405', {
    title: 'GET 访问仅支持 POST 的 /api/auth/verify 返回 405（非 500）',
    expected: 405,
    actual: getAuthVerify.status,
    evidence: { body: getAuthVerify.text.slice(0, 300) },
    level: LEVEL.REAL_JAR
  })
  const getAdminVerify = await get(server.base, '/api/admin/verify')
  collector.expect('s08-get-admin-verify-405', {
    title: 'GET 访问仅支持 POST 的 /api/admin/verify 返回 405（非 500）',
    expected: 405,
    actual: getAdminVerify.status,
    level: LEVEL.REAL_JAR
  })

  // ---- 2. Missing required enum field must be 400, not 500 -------------------------
  const missingLockType = await admin('/api/admin/lock', { locked: true })
  collector.expect('s08-missing-lock-type-400', {
    title: '缺少 lock.type 返回 400（旧版 500 NullPointerException）',
    expected: 400,
    actual: missingLockType.status,
    evidence: { body: missingLockType.text.slice(0, 400) },
    level: LEVEL.REAL_JAR
  })

  // ---- 3. Unknown enum value must be 400 with zero side effects --------------------
  const unknownLockType = await admin('/api/admin/lock', { type: 'BOGUS', locked: true })
  collector.expect('s08-unknown-lock-type-400', {
    title: '未知 lock.type 返回 400（旧版 200 且按未知类型“锁定”）',
    expected: 400,
    actual: unknownLockType.status,
    evidence: { body: unknownLockType.text.slice(0, 400) },
    level: LEVEL.REAL_JAR
  })

  // ---- 4. Negative / out-of-range config rejected, config unchanged ----------------
  const invalidConfig = await admin('/api/admin/config/update', { maxSize: -1, voteSkipThreshold: 2 })
  collector.assert('s08-invalid-config-400', {
    title: 'maxSize=-1 且 voteSkipThreshold=2 返回 400/422，不得静默生效',
    expected: 'HTTP 400 或 422',
    actual: invalidConfig.status,
    condition: [400, 422].includes(invalidConfig.status),
    evidence: { body: invalidConfig.text.slice(0, 400) },
    level: LEVEL.REAL_JAR
  })
  const typeErrorConfig = await admin('/api/admin/config/update', { maxSize: 'abc' })
  collector.assert('s08-type-error-config-400', {
    title: 'maxSize 类型错误返回 400/415，不得 500',
    expected: 'HTTP 400 或 415',
    actual: typeErrorConfig.status,
    condition: [400, 415].includes(typeErrorConfig.status),
    evidence: { body: typeErrorConfig.text.slice(0, 300) },
    level: LEVEL.REAL_JAR
  })

  // ---- 5. Seed a queue, then unknown clear target must NOT clear it ---------------
  const stomp = await connectMember(server.base, 'ValidateMember')
  await admin('/api/admin/system/reset', {})
  await sleep(300)
  stomp.send('/app/enqueue', { platform: 'netease', musicId: 'full' })
  await sleep(900)
  stomp.send('/app/enqueue', { platform: 'netease', musicId: 'fallback' })
  await waitForValue(
    () => {
      const state = stomp.lastJson('/topic/player/state')
      return state && (state.queue?.length > 0 || state.nowPlaying?.music?.id === 'fallback')
    },
    { timeoutMs: 5000, intervalMs: 120 }
  )
  const beforeClear = await snapshot(stomp)
  const beforeQueueLength = Array.isArray(beforeClear.queue) ? beforeClear.queue.length : null
  const beforeNowPlaying = beforeClear.nowPlaying?.music?.id ?? null

  const badClear = await admin('/api/admin/room/clear', { target: 'BOGUS_TARGET' })
  const afterClear = await snapshot(stomp)
  const afterQueueLength = Array.isArray(afterClear.queue) ? afterClear.queue.length : null
  const afterNowPlaying = afterClear.nowPlaying?.music?.id ?? null
  collector.expect('s08-unknown-clear-target-400-zero-side-effect', {
    title: '未知 clear.target 返回 400，且队列/当前曲目保持不变（旧版落入清空队列分支）',
    expected: { status: 400, queueUnchanged: true, nowPlayingUnchanged: true },
    actual: {
      status: badClear.status,
      queueUnchanged: beforeQueueLength === afterQueueLength,
      nowPlayingUnchanged: beforeNowPlaying === afterNowPlaying,
      queueBefore: beforeQueueLength,
      queueAfter: afterQueueLength,
      nowPlayingBefore: beforeNowPlaying,
      nowPlayingAfter: afterNowPlaying
    },
    evidence: { body: badClear.text.slice(0, 400) },
    level: LEVEL.REAL_JAR
  })

  // ---- 6. Valid config update must still work (no over-blocking) -------------------
  const validUpdate = await admin('/api/admin/config/update', { maxSize: 500 })
  const afterValid = await snapshot(stomp)
  collector.expect('s08-valid-config-applied', {
    title: '合法配置更新仍返回 200 且实际生效（maxSize=500）',
    expected: { status: 200, maxQueueSize: 500 },
    actual: { status: validUpdate.status, maxQueueSize: afterValid.config?.maxQueueSize },
    level: LEVEL.REAL_JAR
  })
  await admin('/api/admin/config/update', { maxSize: 1000, voteSkipThreshold: 0.5 })

  // ---- 7. Internal detail leakage across all invalid responses --------------------
  const responseBodies = [
    missingLockType.text,
    unknownLockType.text,
    invalidConfig.text,
    typeErrorConfig.text,
    badClear.text
  ]
  const leaked = responseBodies.some((body) => leaksInternalDetail(body))
  collector.assert('s08-no-internal-detail-in-errors', {
    title: '错误响应不含 NPE/Jackson/Spring 内部类型细节',
    expected: false,
    actual: leaked,
    condition: !leaked,
    evidence: { bodies: responseBodies.map((body) => String(body).slice(0, 240)) },
    level: LEVEL.REAL_JAR
  })

  // ---- 8. Faulty admin auth still 403 (guard, not a regression) --------------------
  const wrongAdmin = await adminRequest(server.base, '/api/admin/verify', { password: 'fixture-wrong' }, { password: 'fixture-wrong' })
  collector.expect('s08-wrong-admin-password-403', {
    title: '错误管理员密码返回 403（保持既有语义）',
    expected: 403,
    actual: wrongAdmin.status,
    level: LEVEL.REAL_JAR
  })

  await stomp.disconnect()
  await server.stop({ graceMs: 0 })
}

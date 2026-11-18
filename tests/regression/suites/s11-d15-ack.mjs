/**
 * D-15 — command ACK channel: every command with a requestId gets a unicast
 * /user/queue/command-ack with a machine-readable code.
 *
 * Expected behavior: PROTOCOL_V2.md §4. Covered codes: OK, GUEST, LOCKED, COOLDOWN
 * (with retryAfterMs), DUPLICATE, QUEUE_FULL, INVALID, UPSTREAM; commands without a
 * requestId produce no ack (legacy behavior).
 *
 * Baseline on the deployed 1.3.9 JAR must FAIL: it silently drops guest/rejected
 * commands and never sends acks, so the client cannot tell success from failure.
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { connectStomp } from '../lib/stomp.mjs'
import { adminRequest, waitForValue } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's11-d15-ack'
export const title = 'D-15 命令 ACK：游客/锁/冷却/重复/队列满/非法/上游失败 code + retryAfterMs'

const ADMIN = 'fixture-admin-d15'
/** Server base is bound once the isolated server starts (see run()). */
let adminServerBase = ''

function admin(apiPath, body) {
  return adminRequest(adminServerBase, apiPath, body, { password: ADMIN }).then((response) => {
    // Diagnostic line so a failed admin precondition is visible in the run log instead of
    // silently leaving LOCKED/QUEUE_FULL tests with unmet preconditions.
    console.log(`[s11][admin] ${apiPath} -> ${response.status}${response.error ? ` ERR:${response.error}` : ''}`)
    return response
  })
}

async function connectMember(baseUrl, name) {
  const stomp = await connectStomp({ baseUrl, headers: { 'user-name': name, 'room-password': '' }, label: name })
  stomp.send('/app/user/rename', { newName: name })
  await stomp.waitJson('/user/queue/me', (json) => json?.name === name && json?.isGuest === false, 5000)
  return stomp
}

/** Send a command and wait for the ack matching its requestId. */
async function command(stomp, destination, body, { requestId = `rq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timeoutMs = 3500 } = {}) {
  const payload = { ...(body || {}), requestId }
  stomp.send(destination, payload)
  const ack = await stomp.waitJson('/user/queue/command-ack', (json) => json?.requestId === requestId, timeoutMs)
  return { requestId, ack }
}

async function stateNowPlaying(stomp) {
  return stomp.lastJson('/topic/player/state')?.nowPlaying?.music?.id ?? null
}

/** Last few player-state frames distilled for failure evidence. */
function stateTail(stomp) {
  return stomp.messages('/topic/player/state').slice(-3).map((message) => ({
    nowPlaying: message.json?.nowPlaying?.music?.id ?? null,
    isPaused: message.json?.isPaused ?? null,
    isPauseLocked: message.json?.isPauseLocked ?? null,
    queueLength: Array.isArray(message.json?.queue) ? message.json.queue.length : null
  }))
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())
  const server = await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir('d15'),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))
  adminServerBase = server.base

  // ================= Guest commands =================================================
  const guest = await connectStomp({ baseUrl: server.base, headers: { 'user-name': '游客', 'room-password': '' }, label: 'guest' })
  await sleep(200)
  const guestEnqueue = await command(guest, '/app/enqueue', { platform: 'netease', musicId: 'full' })
  collector.expect('d15-guest-enqueue-ack', {
    title: '游客点歌返回 ok:false code=GUEST（不再静默丢弃并假成功）',
    expected: { received: true, ok: false, code: 'GUEST', destination: '/app/enqueue', requestIdEcho: true },
    actual: {
      received: Boolean(guestEnqueue.ack),
      ok: guestEnqueue.ack?.ok,
      code: guestEnqueue.ack?.code,
      destination: guestEnqueue.ack?.destination,
      requestIdEcho: guestEnqueue.ack?.requestId === guestEnqueue.requestId
    },
    evidence: { ack: guestEnqueue.ack ?? null },
    level: LEVEL.REAL_JAR
  })
  const guestChat = await command(guest, '/app/chat', { content: 'fixture guest chat' })
  collector.expect('d15-guest-chat-ack', {
    title: '游客聊天返回 ok:false code=GUEST',
    expected: { ok: false, code: 'GUEST' },
    actual: { ok: guestChat.ack?.ok, code: guestChat.ack?.code },
    evidence: { ack: guestChat.ack ?? null },
    level: LEVEL.REAL_JAR
  })
  await guest.disconnect()

  // ================= Member success path ============================================
  const member = await connectMember(server.base, 'AckMember')
  await admin('/api/admin/system/reset', {})
  await sleep(400)
  const okEnqueueResult = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'full' })
  const playingState = await waitForValue(
    () => {
      const state = member.lastJson('/topic/player/state')
      return state?.nowPlaying?.music?.id === 'full' ? state : null
    },
    { timeoutMs: 6000, intervalMs: 100 }
  )
  collector.expect('d15-member-enqueue-ack-ok', {
    title: '成员点歌返回 ok:true code=OK，且歌曲实际进入播放队列',
    expected: { ok: true, code: 'OK', played: true },
    actual: {
      ok: okEnqueueResult.ack?.ok,
      code: okEnqueueResult.ack?.code,
      played: Boolean(playingState)
    },
    evidence: {
      ack: okEnqueueResult.ack ?? null,
      nowPlaying: playingState?.nowPlaying?.music?.id ?? null,
      stateTail: stateTail(member)
    },
    level: LEVEL.REAL_JAR
  })
  const memberChat = await command(member, '/app/chat', { content: 'fixture ack member chat' })
  collector.expect('d15-member-chat-ack-ok', {
    title: '成员聊天返回 ok:true code=OK',
    expected: { ok: true, code: 'OK' },
    actual: { ok: memberChat.ack?.ok, code: memberChat.ack?.code },
    evidence: { ack: memberChat.ack ?? null },
    level: LEVEL.REAL_JAR
  })

  // ================= DUPLICATE ======================================================
  const firstQueue = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'fallback' })
  await sleep(400)
  const duplicate = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'fallback' })
  collector.expect('d15-duplicate-enqueue-code', {
    title: '重复点歌同一曲目返回 ok:false code=DUPLICATE',
    expected: { firstOk: true, duplicateOk: false, code: 'DUPLICATE' },
    actual: { firstOk: firstQueue.ack?.ok, duplicateOk: duplicate.ack?.ok, code: duplicate.ack?.code },
    evidence: { firstAck: firstQueue.ack ?? null, duplicateAck: duplicate.ack ?? null },
    level: LEVEL.REAL_JAR
  })

  // ================= LOCKED =========================================================
  // Preconditions: a fresh song is actually playing and the PAUSE lock is visible in the
  // authoritative state, otherwise LOCKED cannot be expected (the check would be vacuous).
  await admin('/api/admin/system/reset', {})
  await sleep(500)
  const lockEnqueue = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'itemcode' })
  const lockedPlaying = await waitForValue(
    () => {
      const state = member.lastJson('/topic/player/state')
      return state?.nowPlaying?.music?.id === 'itemcode' && state?.isPaused === false ? state : null
    },
    { timeoutMs: 10000, intervalMs: 100 }
  )
  const lockResponse = await admin('/api/admin/lock', { type: 'PAUSE', locked: true })
  const lockedState = await waitForValue(
    () => (member.lastJson('/topic/player/state')?.isPauseLocked === true ? member.lastJson('/topic/player/state') : null),
    { timeoutMs: 5000, intervalMs: 100 }
  )
  await sleep(150)
  const locked = await command(member, '/app/control/toggle-pause', {})
  collector.expect('d15-locked-ack', {
    title: '播放中且暂停锁生效时，toggle-pause 返回 ok:false code=LOCKED',
    expected: { playing: true, pauseLocked: true, ok: false, code: 'LOCKED' },
    actual: {
      playing: Boolean(lockedPlaying && !lockedPlaying.isPaused),
      pauseLocked: Boolean(lockedState),
      ok: locked.ack?.ok,
      code: locked.ack?.code
    },
    condition:
      Boolean(lockedPlaying) &&
      !lockedPlaying.isPaused &&
      Boolean(lockedState) &&
      locked.ack?.ok === false &&
      locked.ack?.code === 'LOCKED',
    evidence: {
      enqueueAck: lockEnqueue.ack ?? null,
      lockStatus: lockResponse.status,
      lockBody: lockResponse.json ?? lockResponse.text.slice(0, 300),
      ack: locked.ack ?? null,
      stateTail: stateTail(member)
    },
    level: LEVEL.REAL_JAR
  })
  await admin('/api/admin/lock', { type: 'PAUSE', locked: false })
  await sleep(200)

  // ================= COOLDOWN (retryAfterMs) ========================================
  await admin('/api/admin/system/reset', {})
  await sleep(500)
  await command(member, '/app/enqueue', { platform: 'netease', musicId: 'nullurl' })
  await waitForValue(() => member.lastJson('/topic/player/state')?.nowPlaying?.music?.id === 'nullurl', {
    timeoutMs: 6000,
    intervalMs: 100
  })
  await sleep(300)
  const firstToggle = await command(member, '/app/control/toggle-pause', {})
  const secondToggle = await command(member, '/app/control/toggle-pause', {})
  const cooldownCode = secondToggle.ack?.code
  const retryAfterMs = secondToggle.ack?.retryAfterMs
  collector.expect('d15-cooldown-ack-retry-after', {
    title: '1 秒冷却内再次操作返回 ok:false code=COOLDOWN 且带 retryAfterMs>0',
    expected: { firstOk: true, secondOk: false, code: 'COOLDOWN', retryAfterMsPositive: true },
    actual: {
      firstOk: firstToggle.ack?.ok,
      secondOk: secondToggle.ack?.ok,
      code: cooldownCode,
      retryAfterMsPositive: typeof retryAfterMs === 'number' && retryAfterMs > 0
    },
    evidence: { firstAck: firstToggle.ack ?? null, secondAck: secondToggle.ack ?? null, retryAfterMs },
    level: LEVEL.REAL_JAR
  })
  // After the advertised cooldown the command must succeed again.
  const waitMs = (typeof retryAfterMs === 'number' && retryAfterMs > 0 ? retryAfterMs : 1200) + 400
  await sleep(waitMs)
  const thirdToggle = await command(member, '/app/control/toggle-pause', {})
  collector.expect('d15-cooldown-expires', {
    title: 'retryAfterMs 之后重试成功（冷却按服务端返回的剩余时间解除）',
    expected: { ok: true, code: 'OK' },
    actual: { ok: thirdToggle.ack?.ok, code: thirdToggle.ack?.code },
    evidence: { waitedMs: waitMs, ack: thirdToggle.ack ?? null },
    level: LEVEL.REAL_JAR
  })

  // ================= INVALID / UPSTREAM =============================================
  const invalid = await command(member, '/app/enqueue', { platform: 'netease', musicId: '' })
  collector.expect('d15-invalid-param-ack', {
    title: '非法参数（空 musicId）返回 ok:false code=INVALID',
    expected: { ok: false, code: 'INVALID' },
    actual: { ok: invalid.ack?.ok, code: invalid.ack?.code },
    evidence: { ack: invalid.ack ?? null },
    level: LEVEL.REAL_JAR
  })
  const upstreamFail = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'bothfail' })
  collector.assert('d15-upstream-failure-ack', {
    title: '上游无合法 URL 返回 ok:false 且 code ∈ {UPSTREAM,INVALID}，message 可诊断',
    expected: 'ok:false 且 code ∈ {UPSTREAM,INVALID} 且 message 非空',
    actual: {
      ok: upstreamFail.ack?.ok,
      code: upstreamFail.ack?.code,
      hasMessage: Boolean(upstreamFail.ack?.message)
    },
    condition:
      upstreamFail.ack?.ok === false &&
      ['UPSTREAM', 'INVALID'].includes(upstreamFail.ack?.code) &&
      Boolean(upstreamFail.ack?.message),
    evidence: { ack: upstreamFail.ack ?? null },
    level: LEVEL.REAL_JAR
  })

  // ================= No requestId → no ack (legacy) ================================
  const ackCountBefore = member.messages('/user/queue/command-ack').length
  member.send('/app/enqueue', { platform: 'netease', musicId: 'nonhttp' })
  await sleep(1200)
  const ackCountAfter = member.messages('/user/queue/command-ack').length
  collector.expect('d15-no-request-id-no-ack', {
    title: '没有 requestId 的旧客户端命令不发送 ack（保持旧行为）',
    expected: 0,
    actual: ackCountAfter - ackCountBefore,
    level: LEVEL.REAL_JAR
  })

  // ================= QUEUE_FULL =====================================================
  // Fresh music ids so the DUPLICATE rule cannot mask QUEUE_FULL. A resolving song still
  // occupies the queue slot; wait until `full` is actually playing (queue empty again),
  // then occupy the only slot and enqueue one more.
  await admin('/api/admin/system/reset', {})
  await sleep(500)
  await admin('/api/admin/config/update', { maxSize: 1 })
  await sleep(300)
  const q1 = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'full' })
  await waitForValue(() => member.lastJson('/topic/player/state')?.nowPlaying?.music?.id === 'full', {
    timeoutMs: 8000,
    intervalMs: 100
  })
  const q2 = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'emptyurl' })
  const q3 = await command(member, '/app/enqueue', { platform: 'netease', musicId: 'bizcode' })
  const codes = [q2.ack?.code, q3.ack?.code]
  collector.assert('d15-queue-full-ack', {
    title: '队列满（maxSize=1）时返回 ok:false code=QUEUE_FULL',
    expected: 'ok:false 且 code=QUEUE_FULL',
    actual: { first: q1.ack?.code, second: q2.ack?.code, third: q3.ack?.code },
    condition: codes.includes('QUEUE_FULL'),
    evidence: { acks: [q1.ack ?? null, q2.ack ?? null, q3.ack ?? null], stateTail: stateTail(member) },
    level: LEVEL.REAL_JAR
  })
  await admin('/api/admin/config/update', { maxSize: 1000 })

  // ================= Reserved rename ================================================
  const rename = await command(member, '/app/user/rename', { newName: 'guest-reserved-name' })
  collector.assert('d15-reserved-rename-ack', {
    title: '保留昵称（guest*）改名返回 ok:false 且 code ∈ {INVALID,GUEST}',
    expected: 'ok:false 且 code ∈ {INVALID,GUEST}',
    actual: { ok: rename.ack?.ok, code: rename.ack?.code },
    condition: rename.ack?.ok === false && ['INVALID', 'GUEST'].includes(rename.ack?.code),
    evidence: { ack: rename.ack ?? null },
    level: LEVEL.REAL_JAR
  })

  await member.disconnect()
  await server.stop({ graceMs: 0 })
}

/**
 * S-01 — playable URL resolution (trial / null / empty / fallback / invalid URL /
 * business failure). Expected behavior: PROTOCOL_V2.md §7.
 *
 * Baseline on the deployed 1.3.9 JAR must FAIL for trial/null/empty-array/non-http URL
 * and MUST PASS for the plain full URL + legacy-404 fallback paths (those worked before).
 */
import path from 'node:path'
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { connectStomp } from '../lib/stomp.mjs'
import { adminRequest, leaksInternalDetail, waitForValue } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's01-playable'
export const title = 'S-01 播放 URL 解析：完整/试听/null/空数组/404 回退/非 HTTP URL/业务失败'

const ADMIN = 'fixture-admin-s01'

/** Extract the PlayableMusic fields the contract cares about from a player state frame. */
function playable(state) {
  const music = state?.nowPlaying?.music
  if (!music) return null
  return {
    id: music.id,
    url: music.url,
    duration: music.duration,
    trial: music.trial,
    urlType: music.urlType,
    playableDurationMs: music.playableDurationMs
  }
}

async function currentState(stomp, timeoutMs = 4000) {
  const before = stomp.messages('/topic/player/state').length
  stomp.send('/app/player/resync', {})
  const fresh = await waitForValue(
    () => (stomp.messages('/topic/player/state').length > before ? stomp.lastJson('/topic/player/state') : null),
    { timeoutMs, intervalMs: 100 }
  )
  return fresh || stomp.lastJson('/topic/player/state') || null
}

async function connectMember(baseUrl, name) {
  const stomp = await connectStomp({ baseUrl, headers: { 'user-name': name, 'room-password': '' }, label: name })
  stomp.send('/app/user/rename', { newName: name })
  await stomp.waitJson('/user/queue/me', (json) => json?.name === name && json?.isGuest === false, 4000)
  return stomp
}

/** Run one enqueue fixture and collect every observable outcome. */
async function runFixture({ stomp, server, upstream, musicId, requestIdPrefix }) {
  await adminRequest(server.base, '/api/admin/system/reset', {}, { password: ADMIN })
  await sleep(350)
  upstream.reset()
  const requestId = `${requestIdPrefix}-${Date.now()}`
  const stateBefore = stomp.messages('/topic/player/state').length
  // Scope event/chat observation to this fixture only (late frames from the previous
  // fixture must not be attributed to this one).
  const eventScopes = ['/topic/player/events', '/user/queue/events']
  const chatScope = '/topic/chat'
  const eventCountBefore = eventScopes.reduce((sum, dest) => sum + stomp.messages(dest).length, 0)
  const chatCountBefore = stomp.messages(chatScope).length
  stomp.send('/app/enqueue', { platform: 'netease', musicId, requestId })

  const ack = await stomp.waitJson('/user/queue/command-ack', (json) => json?.requestId === requestId, 3500)
  const observed = await waitForValue(
    () => {
      const frames = stomp.messages('/topic/player/state').slice(stateBefore)
      const match = frames.filter((frame) => frame.json?.nowPlaying?.music?.id === musicId)
      return match.length ? match[match.length - 1].json : null
    },
    { timeoutMs: 5000, intervalMs: 100 }
  )
  // Let late frames / error events arrive before reading the final state.
  await sleep(500)
  const state = (await currentState(stomp, 3000)) || observed || null
  const eventMessages = eventScopes.flatMap((dest) => stomp.messages(dest))
  const errorBodies = eventMessages.slice(eventCountBefore).map((message) => message.raw)
  const chatBodies = stomp.messages(chatScope).slice(chatCountBefore).map((message) => message.raw)
  return {
    requestId,
    ack,
    state,
    playable: playable(state),
    urlCalls: upstream.playUrlRecords(musicId).map((record) => record.path),
    hasLegacyCall: upstream.playUrlRecords(musicId).some((record) => record.path === '/song/url'),
    hasV1Call: upstream.playUrlRecords(musicId).some((record) => record.path === '/song/url/v1'),
    errorBodies,
    chatBodies
  }
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())
  const server = await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir('s01'),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    // The deployed JAR refuses to resolve playable URLs without a configured cookie;
    // this fixture value is synthetic and only ever sent to the local mock upstream.
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))

  const stomp = await connectMember(server.base, 'VerifierS01')

  // ---- 1. Complete track: v1 returns a normal full URL ------------------------------
  const full = await runFixture({ stomp, server, upstream, musicId: 'full', requestIdPrefix: 'rq-full' })
  collector.expect('s01-full-track', {
    title: '完整歌曲：v1 返回正常 URL → FULL，不请求旧接口，播完整时长',
    expected: {
      id: 'full',
      url: 'https://fixture.invalid/full.mp3',
      duration: 120000,
      trial: false,
      urlType: 'FULL',
      playableDurationMs: 120000
    },
    actual: full.playable,
    evidence: { urlCalls: full.urlCalls, ack: full.ack },
    level: LEVEL.REAL_JAR
  })
  collector.assert('s01-full-no-legacy-call', {
    title: '完整歌曲成功时不应回退到旧 /song/url',
    expected: false,
    actual: full.hasLegacyCall,
    condition: full.hasLegacyCall === false,
    level: LEVEL.REAL_JAR
  })

  // ---- 2. Trial track (30s preview of a 120s song) ----------------------------------
  const trial = await runFixture({ stomp, server, upstream, musicId: 'trial', requestIdPrefix: 'rq-trial' })
  collector.expect('s01-trial-track', {
    title: '试听：识别 trial/freeTrialInfo，trial=true、urlType=TRIAL、可播时长 30s（整曲元数据 120s 保留）',
    expected: {
      id: 'trial',
      url: 'https://fixture.invalid/trial-30s.mp3',
      duration: 120000,
      trial: true,
      urlType: 'TRIAL',
      playableDurationMs: 30000
    },
    actual: trial.playable,
    evidence: { urlCalls: trial.urlCalls, ack: trial.ack },
    level: LEVEL.REAL_JAR
  })

  // ---- 3. v1 url:null → must fall back to legacy /song/url --------------------------
  const nullUrl = await runFixture({ stomp, server, upstream, musicId: 'nullurl', requestIdPrefix: 'rq-nullurl' })
  collector.expect('s01-null-url-no-literal-null', {
    title: 'url:null 不得被当作字符串 "null" 播放；应视为不可用并回退旧接口',
    expected: { id: 'nullurl', url: 'https://fixture.invalid/nullurl-legacy.mp3', trial: false, urlType: 'FULL' },
    actual: { id: nullUrl.playable?.id, url: nullUrl.playable?.url, trial: nullUrl.playable?.trial, urlType: nullUrl.playable?.urlType },
    evidence: { urlCalls: nullUrl.urlCalls, ack: nullUrl.ack },
    level: LEVEL.REAL_JAR
  })

  // ---- 4. Both endpoints `data: []` → structured failure, no NPE leak ---------------
  const emptyArr = await runFixture({ stomp, server, upstream, musicId: 'emptyarr', requestIdPrefix: 'rq-emptyarr' })
  const emptyLeak = [...emptyArr.errorBodies, JSON.stringify(emptyArr.ack ?? '')].some(leaksInternalDetail)
  collector.assert('s01-empty-array-structured-failure', {
    title: '两个接口都 data:[] 时返回结构化失败 ack（UPSTREAM/INVALID），不播放、不泄露 Java 内部异常',
    expected: { ackReceived: true, ok: false, code: 'UPSTREAM|INVALID', played: false, internalDetailLeaked: false },
    actual: {
      ackReceived: Boolean(emptyArr.ack),
      ok: emptyArr.ack?.ok,
      code: emptyArr.ack?.code,
      played: Boolean(emptyArr.playable),
      internalDetailLeaked: emptyLeak
    },
    condition:
      Boolean(emptyArr.ack) &&
      emptyArr.ack?.ok === false &&
      ['UPSTREAM', 'INVALID'].includes(emptyArr.ack?.code) &&
      !emptyArr.playable &&
      !emptyLeak,
    evidence: { ack: emptyArr.ack, errorBodies: emptyArr.errorBodies.slice(-4) },
    level: LEVEL.REAL_JAR
  })

  // ---- 5. v1 HTTP 404 + legacy works → legacy fallback (worked before; keep guard) --
  const fallback = await runFixture({ stomp, server, upstream, musicId: 'fallback', requestIdPrefix: 'rq-fallback' })
  collector.expect('s01-v1-404-fallback', {
    title: 'v1 返回 404 且旧接口正常 → 回退旧接口并播放（旧版本已工作的兼容路径）',
    expected: 'https://fixture.invalid/fallback-legacy.mp3',
    actual: fallback.playable?.url,
    evidence: { urlCalls: fallback.urlCalls },
    level: LEVEL.REAL_JAR
  })

  // ---- 6. Non-http(s) URL must not be played as-is ---------------------------------
  const nonHttp = await runFixture({ stomp, server, upstream, musicId: 'nonhttp', requestIdPrefix: 'rq-nonhttp' })
  collector.assert('s01-non-http-url-rejected', {
    title: 'v1 返回非 http(s) 地址 → 不得原样播放；应视为不可用并回退/失败',
    expected: { playedUrlIsHttp: true, fallsBackToLegacy: true },
    actual: {
      url: nonHttp.playable?.url ?? null,
      playedUrlIsHttp: /^https?:\/\//.test(String(nonHttp.playable?.url ?? '')),
      fallsBackToLegacy: nonHttp.hasLegacyCall
    },
    condition: /^https?:\/\//.test(String(nonHttp.playable?.url ?? '')) && nonHttp.hasLegacyCall,
    evidence: { urlCalls: nonHttp.urlCalls, ack: nonHttp.ack },
    level: LEVEL.REAL_JAR
  })

  // ---- 7. v1 item business code 404 with null URL → legacy fallback ----------------
  const itemCode = await runFixture({ stomp, server, upstream, musicId: 'itemcode', requestIdPrefix: 'rq-itemcode' })
  collector.expect('s01-item-code-fallback', {
    title: '条目 code 非 200/url:null → 回退旧接口',
    expected: 'https://fixture.invalid/itemcode-legacy.mp3',
    actual: itemCode.playable?.url ?? null,
    evidence: { urlCalls: itemCode.urlCalls, ack: itemCode.ack },
    level: LEVEL.REAL_JAR
  })

  // ---- 8. v1 top-level business failure → legacy fallback --------------------------
  const bizCode = await runFixture({ stomp, server, upstream, musicId: 'bizcode', requestIdPrefix: 'rq-bizcode' })
  const bizLeak = [...bizCode.errorBodies, JSON.stringify(bizCode.ack ?? '')].some(leaksInternalDetail)
  collector.expect('s01-business-code-fallback', {
    title: 'v1 顶层业务 code 失败 → 回退旧接口（不把内部异常发给房间）',
    expected: { url: 'https://fixture.invalid/bizcode-legacy.mp3', internalDetailLeaked: false },
    actual: { url: bizCode.playable?.url ?? null, internalDetailLeaked: bizLeak },
    level: LEVEL.REAL_JAR
  })

  // ---- 9. v1 empty-string URL → unusable → legacy fallback -------------------------
  const emptyUrl = await runFixture({ stomp, server, upstream, musicId: 'emptyurl', requestIdPrefix: 'rq-emptyurl' })
  collector.expect('s01-empty-string-url-fallback', {
    title: 'v1 url:"" 视为不可用 → 回退旧接口',
    expected: { url: 'https://fixture.invalid/emptyurl-legacy.mp3', legacyCalled: true },
    actual: { url: emptyUrl.playable?.url ?? null, legacyCalled: emptyUrl.hasLegacyCall },
    level: LEVEL.REAL_JAR
  })

  // ---- 10. Both endpoints fail → structured failure --------------------------------
  const bothFail = await runFixture({ stomp, server, upstream, musicId: 'bothfail', requestIdPrefix: 'rq-bothfail' })
  const bothLeak = [...bothFail.errorBodies, JSON.stringify(bothFail.ack ?? '')].some(leaksInternalDetail)
  collector.assert('s01-both-upstreams-fail', {
    title: '两接口都 404 → 结构化失败 ack，不播放，不泄露内部细节',
    expected: { ackReceived: true, ok: false, code: 'UPSTREAM|INVALID', played: false, internalDetailLeaked: false },
    actual: {
      ackReceived: Boolean(bothFail.ack),
      ok: bothFail.ack?.ok,
      code: bothFail.ack?.code,
      played: Boolean(bothFail.playable),
      internalDetailLeaked: bothLeak
    },
    condition:
      Boolean(bothFail.ack) &&
      bothFail.ack?.ok === false &&
      ['UPSTREAM', 'INVALID'].includes(bothFail.ack?.code) &&
      !bothFail.playable &&
      !bothLeak,
    evidence: { ack: bothFail.ack, errorBodies: bothFail.errorBodies.slice(-4) },
    level: LEVEL.REAL_JAR
  })

  // ---- 11. Secret hygiene: no cookie value in state broadcasts ---------------------
  const rawBodies = stomp.allRawBodies().map((message) => message.raw).join('\n')
  collector.assert('s01-no-cookie-in-broadcast', {
    title: '播放状态/事件广播不得包含上游 Cookie 原文',
    expected: false,
    actual: /MUSIC_U=fixture/i.test(rawBodies),
    condition: !/MUSIC_U=fixture/i.test(rawBodies),
    level: LEVEL.REAL_JAR
  })

  await stomp.disconnect()
  await server.stop({ graceMs: 0 })
  // Surface an unexpected socket artifact if the port did not free up.
  const { isPortListening } = await import('../lib/env.mjs')
  const stillListening = await isPortListening(PORT)
  collector.assert('s01-server-clean-shutdown', {
    title: '测试结束进程清理（端口 18848 无监听）',
    expected: false,
    actual: stillListening,
    condition: stillListening === false,
    level: LEVEL.REAL_JAR
  })
}

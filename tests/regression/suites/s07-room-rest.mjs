/**
 * S-07 — REST room protection via short-lived roomToken.
 *
 * Expected behavior: PROTOCOL_V2.md §6. The protection switch defaults to OFF for old
 * client compatibility (Lead decision), so BOTH modes are exercised:
 *  - default (flag off): legacy clients keep working without X-Room-Token;
 *  - explicit `--app.music-api.room.rest-protection.enabled=true`: protected prefixes
 *    require a valid token from POST /api/auth/verify.
 *
 * Baseline on the deployed 1.3.9 JAR must FAIL (no roomToken, REST fully open).
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { adminRequest, get, post, request } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's07-room-rest'
export const title = 'S-07 REST 房间保护：verify 签发 roomToken、受保护前缀 401/200、默认关闭兼容'

const ADMIN = 'fixture-admin-s07'
const ROOM_PASSWORD = 'fixture-room-pass-20261110'

function admin(base, path, body) {
  return adminRequest(base, path, body, { password: ADMIN })
}

async function makeServer(ctx, dataName, extraArgs = [], extraEnv = {}) {
  return await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir(dataName),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: 'MUSIC_U=valid-start-fixture',
    args: extraArgs,
    extraEnv
  })
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())

  // ================= Mode 1: default (rest-protection OFF) ==========================
  let server = await makeServer(ctx, 's07-default')
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))
  try {
    const passwordResponse = await post(server.base, '/api/auth/setup', { password: ROOM_PASSWORD })
    collector.expect('s07-room-password-setup', {
      title: '设置房间密码成功（后续 REST 保护测试前提）',
      expected: 200,
      actual: passwordResponse.status,
      level: LEVEL.REAL_JAR
    })
    const verifyResponse = await post(server.base, '/api/auth/verify', { password: ROOM_PASSWORD })
    const verifyBody = verifyResponse.json || {}
    collector.expect('s07-verify-issues-room-token', {
      title: 'POST /api/auth/verify 成功且房间有密码时签发 roomToken + expiresInSeconds',
      expected: {
        status: 200,
        valid: true,
        roomTokenNonEmpty: true,
        expiresInSeconds: 1800
      },
      actual: {
        status: verifyResponse.status,
        valid: verifyBody.valid,
        roomTokenNonEmpty: typeof verifyBody.roomToken === 'string' && verifyBody.roomToken.length > 0,
        expiresInSeconds: verifyBody.expiresInSeconds
      },
      evidence: { body: verifyBody, keys: Object.keys(verifyBody) },
      level: LEVEL.REAL_JAR
    })
    // Default OFF: an old web client that never sends X-Room-Token must keep working.
    const legacySearch = await get(server.base, '/api/search/netease/fixture-default')
    collector.expect('s07-default-off-legacy-search', {
      title: 'rest-protection 默认关闭时，旧客户端无 token 的搜索仍返回 200（兼容策略）',
      expected: 200,
      actual: legacySearch.status,
      evidence: { body: legacySearch.text.slice(0, 300) },
      level: LEVEL.REAL_JAR
    })
    collector.expect('s07-config-rest-protection-flag', {
      title: '/api/config 暴露 restProtectionEnabled 布尔标志且默认 false',
      expected: false,
      actual: (await get(server.base, '/api/config')).json?.restProtectionEnabled,
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }

  // ================= Mode 2: rest-protection explicitly ON ==========================
  // Lead decision: protection defaults to false for old-client compatibility, so tests
  // verify both modes. The switch is set via the documented relaxed-binding env var.
  server = await makeServer(ctx, 's07-protected', [], {
    APP_MUSICAPI_ROOM_RESTPROTECTION_ENABLED: 'true',
    ROOM_REST_PROTECTION_ENABLED: 'true'
  })
  try {
    await post(server.base, '/api/auth/setup', { password: ROOM_PASSWORD })
    const verifyResponse = await post(server.base, '/api/auth/verify', { password: ROOM_PASSWORD })
    const verifyBody = verifyResponse.json || {}
    const roomToken = typeof verifyBody.roomToken === 'string' ? verifyBody.roomToken : ''

    collector.expect('s07-protected-verify-issues-token', {
      title: '保护模式下 verify 同样返回 roomToken（顶层字段）',
      expected: { status: 200, roomTokenNonEmpty: true },
      actual: { status: verifyResponse.status, roomTokenNonEmpty: roomToken.length > 0 },
      evidence: { keys: Object.keys(verifyBody) },
      level: LEVEL.REAL_JAR
    })

    const noToken = await get(server.base, '/api/search/netease/fixture-no-token')
    collector.expect('s07-protected-search-without-token', {
      title: '保护模式下无 X-Room-Token 访问 /api/search 返回 401 + code=ROOM_TOKEN_INVALID',
      expected: { status: 401, code: 'ROOM_TOKEN_INVALID' },
      actual: { status: noToken.status, code: noToken.json?.code },
      evidence: { body: noToken.text.slice(0, 400) },
      level: LEVEL.REAL_JAR
    })

    const badToken = await request(server.base, '/api/search/netease/fixture-bad-token', {
      headers: { 'X-Room-Token': 'fixture-invalid-token' }
    })
    collector.expect('s07-protected-search-invalid-token', {
      title: '无效 X-Room-Token 返回 401 + code=ROOM_TOKEN_INVALID',
      expected: { status: 401, code: 'ROOM_TOKEN_INVALID' },
      actual: { status: badToken.status, code: badToken.json?.code },
      level: LEVEL.REAL_JAR
    })

    const withToken = await request(server.base, '/api/search/netease/fixture-with-token', {
      headers: { 'X-Room-Token': roomToken }
    })
    collector.expect('s07-protected-search-valid-token', {
      title: '有效 X-Room-Token 访问 /api/search 返回 200 且结果为数组',
      expected: { status: 200, isArray: true },
      actual: { status: withToken.status, isArray: Array.isArray(withToken.json) },
      evidence: { body: withToken.text.slice(0, 400) },
      level: LEVEL.REAL_JAR
    })

    const lyricNoToken = await get(server.base, '/api/music/lyric/netease/1890001')
    collector.expect('s07-protected-lyric-without-token', {
      title: '保护模式下 /api/music 前缀同样受保护（401）',
      expected: 401,
      actual: lyricNoToken.status,
      level: LEVEL.REAL_JAR
    })

    const playlistNoToken = await get(server.base, '/api/playlist/songs/netease/123456')
    collector.expect('s07-protected-playlist-without-token', {
      title: '保护模式下 /api/playlist 前缀同样受保护（401）',
      expected: 401,
      actual: playlistNoToken.status,
      level: LEVEL.REAL_JAR
    })

    const userSearchNoToken = await get(server.base, '/api/user/playlists/netease/10001')
    collector.expect('s07-protected-user-prefix-without-token', {
      title: '保护模式下 /api/user 前缀同样受保护（401）',
      expected: 401,
      actual: userSearchNoToken.status,
      level: LEVEL.REAL_JAR
    })

    const authStatusNoToken = await get(server.base, '/api/auth/status')
    collector.expect('s07-auth-status-unaffected', {
      title: '/api/auth/** 不受 REST 房间保护影响（无需 token）',
      expected: 200,
      actual: authStatusNoToken.status,
      level: LEVEL.REAL_JAR
    })

    const versionNoToken = await get(server.base, '/api/version')
    collector.expect('s07-version-unaffected', {
      title: '/api/version 不受 REST 房间保护影响（200）',
      expected: 200,
      actual: versionNoToken.status,
      level: LEVEL.REAL_JAR
    })

    const adminVerify = await adminRequest(server.base, '/api/admin/verify', { password: ADMIN }, { password: ADMIN })
    collector.expect('s07-admin-unaffected', {
      title: '/api/admin/** 只受管理员密码保护，不需要 X-Room-Token',
      expected: { status: 200 },
      actual: { status: adminVerify.status },
      level: LEVEL.REAL_JAR
    })

    // A token from the previous instance must not be accepted after a restart (new
    // in-memory signing state); rooms without a password do not require protection.
    collector.skip('s07-token-revocation', {
      title: 'roomToken 撤销/轮换语义',
      expected: '协议未定义显式撤销端点；仅以过期时间 1800s 约束',
      reason: 'PROTOCOL_V2.md 未定义撤销 API，且 30 分钟过期无法在回归中等待，故如实标为未验证。',
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }

  // Guard: an unprotected (no room password) server must not require a token.
  server = await makeServer(ctx, 's07-open', [], {
    APP_MUSICAPI_ROOM_RESTPROTECTION_ENABLED: 'true',
    ROOM_REST_PROTECTION_ENABLED: 'true'
  })
  try {
    const openSearch = await get(server.base, '/api/search/netease/fixture-open-room')
    collector.expect('s07-open-room-search-without-token', {
      title: '无密码房间即使保护开关开启也不要求 token（搜索 200）',
      expected: 200,
      actual: openSearch.status,
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }
  await sleep(100)
}

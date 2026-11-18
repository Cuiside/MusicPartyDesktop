/**
 * O-03 — startup NetEase cookie normalization: paired quotes / whitespace / placeholders
 * must not be treated as a usable credential, and a legitimately quoted cookie must be
 * unquoted before being sent upstream.
 *
 * Expected behavior: PROTOCOL_V2.md §8 + BUGREPORT O-03. Baseline on the deployed 1.3.9
 * JAR must FAIL (the two-quote env value was treated as a real cookie).
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { get, post, adminRequest } from '../lib/http.mjs'
import { DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 'o03-cookie-normalization'
export const title = 'O-03 Cookie 归一化：纯引号/空白视为空，带引号有效值去引号后使用'

const ADMIN = 'fixture-admin-o03'

async function launch(ctx, name, neteaseCookie) {
  return await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir(name),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie
  })
}

/** Cookie the upstream actually received for the last search (null when no search happened). */
function upstreamCookieForSearch(upstream) {
  const searches = upstream.records.filter((record) => record.path === '/search' || record.path === '/cloudsearch')
  if (!searches.length) return null
  return searches[searches.length - 1].cookie
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())

  // ============ Instance A: startup cookie is exactly two quote characters =========
  let server = await launch(ctx, 'o03-two-quotes', '""')
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))
  try {
    const config = (await get(server.base, '/api/config')).json || {}
    collector.expect('o03-two-quotes-config', {
      title: '启动 Cookie 为两个引号时 /api/config 报告 neteaseConfigured=false、cookieSource=none',
      expected: { neteaseConfigured: false, cookieSource: 'none' },
      actual: { neteaseConfigured: config.neteaseConfigured, cookieSource: config.cookieSource },
      evidence: { body: JSON.stringify(config).slice(0, 700) },
      level: LEVEL.REAL_JAR
    })
    upstream.reset()
    const search = await get(server.base, '/api/search/netease/fixture-quotes')
    const cookieUsed = upstreamCookieForSearch(upstream)
    collector.expect('o03-two-quotes-not-sent-upstream', {
      title: '纯引号 Cookie 不得作为可用凭据发送给上游（上游收到的 cookie 参数不是 ""）',
      expected: { cookieIsNotTwoQuotes: true, cookieEmpty: true },
      actual: { cookieUsed, cookieIsNotTwoQuotes: cookieUsed !== '""', cookieEmpty: cookieUsed === '' || cookieUsed === null },
      evidence: { searchStatus: search.status, upstreamRecords: upstream.records.map((record) => record.path) },
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }

  // ============ Instance B: quoted + spaced but valid cookie ========================
  server = await launch(ctx, 'o03-quoted-valid', '"  MUSIC_U=valid-quoted-fixture  "')
  try {
    const config = (await get(server.base, '/api/config')).json || {}
    upstream.reset()
    const search = await get(server.base, '/api/search/netease/fixture-quoted')
    const cookieUsed = upstreamCookieForSearch(upstream)
    collector.expect('o03-quoted-valid-normalized', {
      title: '带引号/空白的有效 Cookie 去引号 trim 后使用（上游收到 MUSIC_U=valid-quoted-fixture）',
      expected: { cookieUsed: 'MUSIC_U=valid-quoted-fixture', neteaseConfigured: true },
      actual: { cookieUsed, neteaseConfigured: config.neteaseConfigured },
      evidence: { searchStatus: search.status },
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }

  // ============ Instance C: admin update with a quoted cookie =======================
  server = await launch(ctx, 'o03-update-quoted', 'MUSIC_U=valid-start-fixture')
  try {
    upstream.reset()
    const update = await adminRequest(server.base, '/api/admin/config/cookie', {
      platform: 'netease',
      value: '"MUSIC_U=valid-updated-quoted-fixture"'
    }, { password: ADMIN })
    const updateBody = update.json || {}
    const search = await get(server.base, '/api/search/netease/fixture-update-quoted')
    const cookieUsed = upstreamCookieForSearch(upstream)
    collector.expect('o03-admin-update-quoted-normalized', {
      title: '管理接口更新带引号 Cookie：验证通过、持久化、上游收到去引号值',
      expected: { status: 200, verified: true, cookieUsed: 'MUSIC_U=valid-updated-quoted-fixture' },
      actual: { status: update.status, verified: updateBody.verified, cookieUsed },
      evidence: { body: updateBody, searchStatus: search.status },
      level: LEVEL.REAL_JAR
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }
}

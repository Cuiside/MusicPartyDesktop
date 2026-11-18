/**
 * S-05 / S-06 — credential persistence and validation.
 *
 * Expected behavior: PROTOCOL_V2.md §8.
 *  - a valid cookie update is verified upstream first, persisted to data/secrets.json and
 *    survives a server restart (persisted > env/startup value);
 *  - an invalid cookie update returns 400/422, keeps the previous working cookie, and is
 *    never persisted;
 *  - cookie/admin secrets never appear in /api/config, broadcasts or logs.
 *
 * Baseline on the deployed 1.3.9 JAR must FAIL: updates only change memory (lost on
 * restart) and invalid updates return 200 and replace the working cookie.
 */
import fs from 'node:fs'
import path from 'node:path'
import { startUpstream } from '../lib/upstream.mjs'
import { startServer, dataDirContainsSecret } from '../lib/server.mjs'
import { adminRequest, get } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's05-s06-cookie'
export const title = 'S-05/S-06 凭据：验证后原子替换、持久化重启保留、无效值 400 保留旧值、秘密不泄漏'

const ADMIN = 'fixture-admin-s05'
const START_COOKIE = 'MUSIC_U=valid-start-fixture'
const START_COOKIE_2 = 'MUSIC_U=valid-second-start-fixture'
const UPDATED_COOKIE = 'MUSIC_U=valid-updated-fixture'
const INVALID_COOKIE = 'MUSIC_U=invalid-fixture'

function lastSearchCookie(upstream) {
  const records = upstream.records.filter((record) => record.path === '/search' || record.path === '/cloudsearch')
  return records.length ? records[records.length - 1].cookie : null
}

async function launch(ctx, dataDir, startupCookie) {
  return await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir,
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: startupCookie
  })
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())
  const dataDir = ctx.makeDataDir('s05')
  let server = await launch(ctx, dataDir, START_COOKIE)
  let cleanupServer = server
  ctx.onCleanup(async () => {
    await cleanupServer.stop({ graceMs: 0 })
  })

  try {
    // ---------- 1. startup cookie is used, and config reports its source -------------
    upstream.reset()
    await get(server.base, '/api/search/netease/fixture-start')
    collector.expect('s05-startup-cookie-used', {
      title: '启动配置的 Cookie 被实际用于上游搜索（基线前提）',
      expected: START_COOKIE,
      actual: lastSearchCookie(upstream),
      level: LEVEL.REAL_JAR
    })
    const configStart = (await get(server.base, '/api/config')).json || {}
    collector.expect('s05-config-cookie-source-env', {
      title: '/api/config 报告 cookieSource=env、neteaseConfigured=true、adminConfigured=true',
      expected: { cookieSource: 'env', neteaseConfigured: true, adminConfigured: true },
      actual: {
        cookieSource: configStart.cookieSource,
        neteaseConfigured: configStart.neteaseConfigured,
        adminConfigured: configStart.adminConfigured
      },
      evidence: { body: JSON.stringify(configStart).slice(0, 700) },
      level: LEVEL.REAL_JAR
    })

    // ---------- 2. invalid cookie update must be rejected, old value kept -----------
    upstream.reset()
    const invalidUpdate = await adminRequest(server.base, '/api/admin/config/cookie', {
      platform: 'netease',
      value: INVALID_COOKIE
    }, { password: ADMIN })
    collector.assert('s06-invalid-cookie-rejected', {
      title: '无效 Cookie 更新返回 400/422 而不是 200（先验证后替换）',
      expected: { statusIn: [400, 422], verifiedFalse: true, messageMentionsReason: true },
      actual: {
        status: invalidUpdate.status,
        verified: invalidUpdate.json?.verified,
        message: invalidUpdate.json?.message ?? null
      },
      condition:
        [400, 422].includes(invalidUpdate.status) &&
        invalidUpdate.json?.verified !== true &&
        /验证|保留|invalid|失效/i.test(String(invalidUpdate.json?.message || '')),
      evidence: { body: invalidUpdate.text.slice(0, 500) },
      level: LEVEL.REAL_JAR
    })
    upstream.reset()
    await get(server.base, '/api/search/netease/fixture-after-invalid')
    collector.expect('s06-invalid-cookie-keeps-old', {
      title: '无效更新失败后原可用 Cookie 继续生效（不被替换）',
      expected: START_COOKIE,
      actual: lastSearchCookie(upstream),
      evidence: { upstreamRecords: upstream.records.map((record) => record.path) },
      level: LEVEL.REAL_JAR
    })
    const invalidPersisted = dataDirContainsSecret(dataDir, INVALID_COOKIE)
    collector.expect('s06-invalid-cookie-not-persisted', {
      title: '无效 Cookie 不得写入任何持久化文件',
      expected: [],
      actual: invalidPersisted,
      level: LEVEL.REAL_JAR
    })

    // ---------- 3. quoted invalid cookie is normalized and rejected too -------------
    const quotedInvalid = await adminRequest(server.base, '/api/admin/config/cookie', {
      platform: 'netease',
      value: `"${INVALID_COOKIE}"`
    }, { password: ADMIN })
    collector.assert('s06-quoted-invalid-cookie-rejected', {
      title: '带引号的无效 Cookie 归一化后仍被拒绝（400/422）',
      expected: 'HTTP 400 或 422',
      actual: quotedInvalid.status,
      condition: [400, 422].includes(quotedInvalid.status),
      evidence: { body: quotedInvalid.text.slice(0, 400) },
      level: LEVEL.REAL_JAR
    })

    // ---------- 4. valid cookie update: verified + persisted ------------------------
    upstream.reset()
    const validUpdate = await adminRequest(server.base, '/api/admin/config/cookie', {
      platform: 'netease',
      value: UPDATED_COOKIE
    }, { password: ADMIN })
    const validBody = validUpdate.json || {}
    collector.expect('s05-valid-cookie-update-verified-persisted', {
      title: '有效 Cookie 更新返回 200 + verified=true + source=persisted',
      expected: { status: 200, verified: true, source: 'persisted' },
      actual: { status: validUpdate.status, verified: validBody.verified, source: validBody.source },
      evidence: { body: validBody },
      level: LEVEL.REAL_JAR
    })
    upstream.reset()
    await get(server.base, '/api/search/netease/fixture-after-valid')
    collector.expect('s05-updated-cookie-effective-before-restart', {
      title: '更新后立即生效（上游收到新 Cookie）',
      expected: UPDATED_COOKIE,
      actual: lastSearchCookie(upstream),
      level: LEVEL.REAL_JAR
    })
    const secretsFile = path.join(dataDir, 'data', 'secrets.json')
    const secretsExists = fs.existsSync(secretsFile)
    const secretsText = secretsExists ? fs.readFileSync(secretsFile, 'utf8') : ''
    collector.expect('s05-secrets-file-persisted', {
      title: 'data/secrets.json 存在且包含更新后的 Cookie（权限受限的秘密存储）',
      expected: { exists: true, containsUpdatedCookie: true },
      actual: { exists: secretsExists, containsUpdatedCookie: secretsText.includes(UPDATED_COOKIE) },
      evidence: { file: secretsFile, size: secretsText.length },
      level: LEVEL.REAL_JAR
    })

    // ---------- 5. secrets must not leak into config/version/logs -------------------
    const configAfter = (await get(server.base, '/api/config')).json || {}
    const versionAfter = await get(server.base, '/api/version')
    const configText = JSON.stringify(configAfter)
    const leaksConfig = [UPDATED_COOKIE, START_COOKIE, ADMIN].some(
      (secret) => configText.includes(secret) || versionAfter.text.includes(secret)
    )
    collector.expect('s05-secrets-not-in-config', {
      title: '/api/config 与 /api/version 不包含任何 Cookie 原文或管理员密码',
      expected: false,
      actual: leaksConfig,
      level: LEVEL.REAL_JAR
    })
    const logs = server.logs()
    const logLeaks = [START_COOKIE, UPDATED_COOKIE, INVALID_COOKIE, ADMIN].filter((secret) => logs.includes(secret))
    collector.expect('s05-secrets-not-in-logs', {
      title: '服务端日志不打印 Cookie 原文与管理员密码（只允许来源 persisted/env/none）',
      expected: [],
      actual: logLeaks,
      evidence: { logLength: logs.length },
      level: LEVEL.REAL_JAR
    })

    // ---------- 6. restart with a different startup cookie: persisted must win ------
    await sleep(600)
    cleanupServer = null
    await server.stop({ graceMs: 900 })
    server = await launch(ctx, dataDir, START_COOKIE_2)
    cleanupServer = server

    const configRestart = (await get(server.base, '/api/config')).json || {}
    collector.expect('s05-restart-cookie-source-persisted', {
      title: '重启后 /api/config 报告 cookieSource=persisted',
      expected: 'persisted',
      actual: configRestart.cookieSource,
      evidence: { body: JSON.stringify(configRestart).slice(0, 700) },
      level: LEVEL.REAL_JAR
    })
    upstream.reset()
    await get(server.base, '/api/search/netease/fixture-after-restart')
    collector.expect('s05-cookie-retained-after-restart', {
      title: '重启后仍使用持久化的更新值（优先级 persisted > 环境/启动值）',
      expected: UPDATED_COOKIE,
      actual: lastSearchCookie(upstream),
      evidence: { startupCookie: START_COOKIE_2, upstreamRecords: upstream.records.map((record) => record.path) },
      level: LEVEL.REAL_JAR
    })
    // Guard: admin password from startup argument still works after restart.
    const adminAfterRestart = await adminRequest(server.base, '/api/admin/verify', { password: ADMIN }, { password: ADMIN })
    collector.expect('s05-admin-verify-after-restart', {
      title: '重启后管理员验证仍正常（管理员密码来自启动配置）',
      expected: 200,
      actual: adminAfterRestart.status,
      level: LEVEL.REAL_JAR
    })
  } finally {
    if (cleanupServer) await cleanupServer.stop({ graceMs: 0 })
  }
}

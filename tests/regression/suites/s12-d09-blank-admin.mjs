/**
 * D-09 (server side) — a blank / whitespace / default-placeholder admin password must
 * never authenticate, and /api/config + /api/auth/status must report adminConfigured=false.
 *
 * Expected behavior: PROTOCOL_V2.md §1 + BUGREPORT D-09. Baseline on the deployed 1.3.9
 * JAR must FAIL (POST /api/admin/verify {password:""} returns 200).
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { adminRequest, get } from '../lib/http.mjs'
import { DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's12-d09-blank-admin'
export const title = 'D-09 空/空白/占位管理员密码不得认证通过，adminConfigured=false'


async function launch(ctx, name, { adminPassword, extraEnv }) {
  return await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir(name),
    upstreamPort: UPSTREAM_PORT,
    ...(adminPassword !== undefined ? { adminPassword } : {}),
    ...(extraEnv ? { extraEnv } : {}),
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
}

async function evaluateInstance({ collector, server, label, candidates }) {
  const config = (await get(server.base, '/api/config')).json || {}
  collector.expect(`${label}-config-admin-configured-false`, {
    title: `${label}: /api/config adminConfigured=false（秘密未有效配置）`,
    expected: false,
    actual: config.adminConfigured,
    evidence: { body: JSON.stringify(config).slice(0, 600) },
    level: LEVEL.REAL_JAR
  })
  const authStatus = (await get(server.base, '/api/auth/status')).json || {}
  collector.expect(`${label}-auth-status-admin-configured-false`, {
    title: `${label}: /api/auth/status 暴露 adminConfigured=false`,
    expected: false,
    actual: authStatus.adminConfigured,
    evidence: { body: JSON.stringify(authStatus).slice(0, 400) },
    level: LEVEL.REAL_JAR
  })
  for (const candidate of candidates) {
    const response = await adminRequest(server.base, '/api/admin/verify', { password: candidate.value }, {
      password: candidate.value
    })
    collector.expect(`${label}-verify-${candidate.slug}-rejected`, {
      title: `${label}: 管理员验证使用${candidate.title}必须返回 403`,
      expected: 403,
      actual: response.status,
      evidence: { body: response.text.slice(0, 300) },
      level: LEVEL.REAL_JAR
    })
  }
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())

  // Instance A: empty admin password supplied through the launcher-style environment
  // variable (relaxed binding), no command-line argument at all.
  let server = await launch(ctx, 'd09-env-blank', { extraEnv: { APP_MUSICAPI_ADMINPASSWORD: '' } })
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))
  try {
    await evaluateInstance({
      collector,
      server,
      label: 'd09-env-empty',
      candidates: [
        { slug: 'empty', title: '空字符串', value: '' },
        { slug: 'spaces', title: '纯空格', value: '   ' }
      ]
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }

  // Instance B: whitespace-only password via CLI argument.
  server = await launch(ctx, 'd09-cli-spaces', { adminPassword: '   ' })
  try {
    await evaluateInstance({
      collector,
      server,
      label: 'd09-cli-spaces',
      candidates: [
        { slug: 'empty', title: '空字符串', value: '' },
        { slug: 'spaces', title: '纯空格', value: '   ' }
      ]
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }

  // Instance C: default placeholder 'admin123' must count as not configured and be
  // rejected as a credential.
  server = await launch(ctx, 'd09-placeholder', { adminPassword: 'admin123' })
  try {
    await evaluateInstance({
      collector,
      server,
      label: 'd09-placeholder',
      candidates: [
        { slug: 'admin123', title: '默认占位符 admin123', value: 'admin123' },
        { slug: 'empty', title: '空字符串', value: '' }
      ]
    })
  } finally {
    await server.stop({ graceMs: 0 })
  }
}

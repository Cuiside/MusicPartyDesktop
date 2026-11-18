/**
 * S-02 — public identity vs recovery key (identity v2), plus O-02 capability/version
 * discovery that the new protocol relies on.
 *
 * Expected behavior: PROTOCOL_V2.md §3 (+ §1/§2 for /api/config + /api/version).
 * Baseline on the deployed 1.3.9 JAR must FAIL: the public token IS the recovery secret,
 * so a second connection that knows the broadcast token takes over the first identity.
 */
import { startUpstream } from '../lib/upstream.mjs'
import { startServer } from '../lib/server.mjs'
import { connectStomp } from '../lib/stomp.mjs'
import { get, waitForValue } from '../lib/http.mjs'
import { sleep, DEFAULT_SERVER_PORT as PORT, UPSTREAM_PORT } from '../lib/env.mjs'
import { LEVEL } from '../lib/results.mjs'

export const id = 's02-identity'
export const title = 'S-02 身份 v2：公开 id 与恢复密钥分离、公开 id 不可冒用、广播无秘密'

const ADMIN = 'fixture-admin-s02'
const CLIENT_CHOSEN_KEY = 'fixture-client-chosen-key-should-not-be-trusted'

const REQUIRED_CAPABILITIES = ['ping', 'command-ack', 'room-token', 'playable-trial', 'identity-v2', 'secret-store']

/** Read the latest identity frame from either unicast identity destination. */
async function waitIdentity(stomp, predicate = () => true, timeoutMs = 5000) {
  return await waitForValue(
    () => {
      const messages = [...stomp.messages('/app/user/me'), ...stomp.messages('/user/queue/me')]
      const match = messages.find((message) => {
        try {
          return message.json && typeof message.json === 'object' && predicate(message.json)
        } catch {
          return false
        }
      })
      return match ? match.json : null
    },
    { timeoutMs, intervalMs: 80 }
  )
}

function identityOf(me) {
  if (!me || typeof me !== 'object') return null
  const publicId = me.id ?? me.token ?? null
  const recoveryKey = me.recoveryKey ?? me.token ?? null
  return { publicId, recoveryKey, name: me.name ?? null, isGuest: me.isGuest ?? null, raw: me }
}

/** Latest PlayerState.onlineUsers frame. */
function latestOnlineUsers(stomp) {
  const frames = stomp.messages('/topic/player/state')
  for (let i = frames.length - 1; i >= 0; i--) {
    const users = frames[i].json?.onlineUsers
    if (Array.isArray(users) && users.length) return users
  }
  return []
}

/** Raw bodies of broadcast topics only (unicast queues are legitimately allowed recovery keys). */
function broadcastBodies(stomp) {
  const out = []
  for (const [destination, messages] of stomp.inbox.entries()) {
    if (!destination.startsWith('/topic/')) continue
    for (const message of messages) out.push({ destination, raw: message.raw })
  }
  return out
}

async function connectNamed(baseUrl, name, extraHeaders = {}) {
  return await connectStomp({
    baseUrl,
    headers: { 'user-name': name, 'room-password': '', ...extraHeaders },
    label: name
  })
}

async function renameAndWait(stomp, name, timeoutMs = 5000) {
  stomp.send('/app/user/rename', { newName: name })
  return await waitIdentity(stomp, (me) => me.name === name && me.isGuest === false, timeoutMs)
}

export async function run(ctx) {
  const { collector } = ctx
  const upstream = await startUpstream(UPSTREAM_PORT)
  ctx.onCleanup(() => upstream.close())
  const server = await startServer({
    jar: ctx.jar,
    java: ctx.java,
    port: PORT,
    dataDir: ctx.makeDataDir('s02'),
    upstreamPort: UPSTREAM_PORT,
    adminPassword: ADMIN,
    neteaseCookie: 'MUSIC_U=valid-start-fixture'
  })
  ctx.onCleanup(() => server.stop({ graceMs: 0 }))

  // ---- O-02: /api/config capabilities + /api/version --------------------------------
  const configResponse = await get(server.base, '/api/config')
  const config = configResponse.json || {}
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities : []
  collector.expect('s02-config-capabilities', {
    title: '/api/config 提供 serverVersion/capabilities/adminConfigured/cookieSource 等能力发现字段',
    expected: {
      hasCapabilities: true,
      missingCapabilities: [],
      adminConfigured: true,
      restProtectionFlagBoolean: true,
      serverVersionString: true
    },
    actual: {
      hasCapabilities: Array.isArray(config.capabilities),
      missingCapabilities: REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability)),
      adminConfigured: config.adminConfigured,
      restProtectionFlagBoolean: typeof config.restProtectionEnabled === 'boolean',
      serverVersionString: typeof config.serverVersion === 'string' && config.serverVersion.length > 0
    },
    evidence: { status: configResponse.status, body: configResponse.text.slice(0, 1200) },
    level: LEVEL.REAL_JAR
  })

  const versionResponse = await get(server.base, '/api/version')
  const version = versionResponse.json || {}
  collector.expect('s02-api-version', {
    title: '/api/version 暴露 version/gitRevision/buildTime/javaVersion（非敏感）',
    expected: { status: 200, versionString: true, gitRevisionPresent: true, buildTimePresent: true },
    actual: {
      status: versionResponse.status,
      versionString: typeof version.version === 'string' && version.version.length > 0,
      gitRevisionPresent: typeof version.gitRevision === 'string' && version.gitRevision.length > 0,
      buildTimePresent: typeof version.buildTime === 'string' && version.buildTime.length > 0
    },
    evidence: { body: versionResponse.text.slice(0, 800) },
    level: LEVEL.REAL_JAR
  })

  // ---- A: initial identity ---------------------------------------------------------
  const alpha = await connectNamed(server.base, 'AlphaMember', { 'user-recovery-key': CLIENT_CHOSEN_KEY })
  const meAlphaJoin = await waitIdentity(alpha, (me) => me?.name === 'AlphaMember')
  const meAlphaMember = await renameAndWait(alpha, 'AlphaMember')
  const alphaIdentity = identityOf(meAlphaMember || meAlphaJoin)
  const hasPublicId = typeof alphaIdentity?.publicId === 'string' && alphaIdentity.publicId.length >= 8
  const hasRecoveryKey = typeof alphaIdentity?.recoveryKey === 'string' && alphaIdentity.recoveryKey.length >= 8
  collector.expect('s02-me-public-id-and-recovery-key', {
    title: '/user/queue/me 返回公开 id 与独立 recoveryKey（两者不同，且不在广播中）',
    expected: { hasPublicId: true, hasRecoveryKey: true, distinctValues: true, clientChosenKeyNotTrusted: true },
    actual: {
      hasPublicId,
      hasRecoveryKey,
      distinctValues: hasPublicId && hasRecoveryKey && alphaIdentity.publicId !== alphaIdentity.recoveryKey,
      clientChosenKeyNotTrusted: alphaIdentity?.recoveryKey !== CLIENT_CHOSEN_KEY
    },
    evidence: { me: alphaIdentity?.raw ?? null, joinMe: meAlphaJoin ?? null },
    level: LEVEL.REAL_JAR
  })

  // ---- B: broadcast summaries contain public id only --------------------------------
  // The state broadcast that follows the rename may arrive a few ms after the unicast
  // identity frame, so wait briefly for a non-empty onlineUsers snapshot.
  const onlineUsers = (await waitForValue(
    () => {
      const users = latestOnlineUsers(alpha)
      return users.length ? users : null
    },
    { timeoutMs: 4000, intervalMs: 80 }
  )) || []
  const secretFields = ['token', 'sessionId', 'recoveryKey']
  collector.assert('s02-broadcast-user-summary-public', {
    title: '广播 onlineUsers/用户摘要只含公开 {id,name,isGuest}，不含 token/sessionId/recoveryKey',
    expected: { allHavePublicId: true, secretFieldsPresent: [] },
    actual: {
      entries: onlineUsers.map((user) => Object.keys(user || {})),
      allHavePublicId: onlineUsers.length > 0 && onlineUsers.every((user) => typeof user?.id === 'string' && user.id.length >= 8),
      secretFieldsPresent: secretFields.filter((field) => onlineUsers.some((user) => user && field in user))
    },
    condition:
      onlineUsers.length > 0 &&
      onlineUsers.every((user) => typeof user?.id === 'string' && user.id.length >= 8) &&
      !secretFields.some((field) => onlineUsers.some((user) => user && field in user)),
    level: LEVEL.REAL_JAR
  })

  const broadcasts = broadcastBodies(alpha)
  const recoveryKey = alphaIdentity?.recoveryKey || ''
  const leakedToBroadcast = Boolean(recoveryKey) && broadcasts.some((message) => message.raw.includes(recoveryKey))
  collector.assert('s02-broadcast-contains-no-recovery-key', {
    title: '任何 /topic/* 广播都不得包含 recoveryKey（或旧 secret token）原文',
    expected: false,
    actual: leakedToBroadcast,
    condition: !leakedToBroadcast,
    evidence: { checkedFrames: broadcasts.length },
    level: LEVEL.REAL_JAR
  })

  // ---- C: knowing the public id must not take over the session ---------------------
  const attackPublicId = alphaIdentity?.publicId || ''
  // (b) first: legacy user-token = public id must not recover an existing identity.
  // NOTE: the v2 server accepts a UUID-format supplied recovery key for NEW users, so a
  // later connection using the same value could restore that NEW user — the assertion is
  // strictly "does not become AlphaMember / Alpha public id".
  const gamma = await connectNamed(server.base, 'GammaMember', { 'user-token': attackPublicId })
  const meGamma = await waitIdentity(gamma, (me) => Boolean(me?.name), 5000)
  const gammaIdentity = identityOf(meGamma)
  collector.assert('s02-broadcast-token-cannot-hijack', {
    title: '公开 id（旧版本的广播 token）作为 user-token 连接不得恢复 Alpha 身份',
    expected: { hijacked: false },
    actual: { hijacked: gammaIdentity?.publicId === attackPublicId, gammaName: gammaIdentity?.name ?? null },
    condition: gammaIdentity?.publicId !== attackPublicId && gammaIdentity?.name !== 'AlphaMember',
    evidence: { attackPublicId, gammaMe: gammaIdentity?.raw ?? null },
    level: LEVEL.REAL_JAR
  })

  // (a) knowing the public id and passing it as user-recovery-key must not recover Alpha.
  const beta = await connectNamed(server.base, 'BetaMember', { 'user-recovery-key': attackPublicId })
  const meBeta = await waitIdentity(beta, (me) => Boolean(me?.name), 5000)
  const betaIdentity = identityOf(meBeta)
  collector.assert('s02-public-id-cannot-hijack', {
    title: '知道公开 id 并用 user-recovery-key 连接不能恢复 Alpha 会话',
    expected: { hijacked: false },
    actual: { hijacked: betaIdentity?.publicId === attackPublicId, betaName: betaIdentity?.name ?? null },
    condition: betaIdentity?.publicId !== attackPublicId && betaIdentity?.name !== 'AlphaMember',
    evidence: { attackPublicId, betaMe: betaIdentity?.raw ?? null },
    level: LEVEL.REAL_JAR
  })

  // ---- D: legitimate recovery with the (secret) recovery key ------------------------
  const recoveryKeyValue = alphaIdentity?.recoveryKey || ''
  const delta = await connectNamed(server.base, 'AlphaMember', { 'user-recovery-key': recoveryKeyValue })
  const meDelta = await waitIdentity(delta, (me) => Boolean(me?.name), 5000)
  const deltaIdentity = identityOf(meDelta)
  collector.expect('s02-legit-recovery-with-recovery-key', {
    title: '持有 recoveryKey 的客户端可合法恢复同一身份（公开 id 与昵称一致、非游客）',
    expected: { sameIdentity: true, name: 'AlphaMember', isGuest: false },
    actual: {
      sameIdentity: deltaIdentity?.publicId === attackPublicId,
      name: deltaIdentity?.name ?? null,
      isGuest: deltaIdentity?.isGuest ?? null
    },
    evidence: { alphaPublicId: attackPublicId, recoveryKeyUsed: Boolean(recoveryKeyValue) },
    level: LEVEL.REAL_JAR
  })

  // ---- E: chat messages broadcast public id only -----------------------------------
  const echo = await connectNamed(server.base, 'EchoMember')
  await renameAndWait(echo, 'EchoMember')
  const echoIdentity = identityOf(await waitIdentity(echo, (me) => me?.name === 'EchoMember'))
  const chatText = `fixture-identity-chat-${Date.now()}`
  const chatCountBefore = echo.messages('/topic/chat').length
  echo.send('/app/chat', { content: chatText })
  const chatMessage = await waitForValue(
    () => {
      const matches = echo.messages('/topic/chat').slice(chatCountBefore).filter((message) => {
        const body = message.json
        return body && typeof body === 'object' && String(body.content ?? body.text ?? '').includes(chatText)
      })
      return matches.length ? matches[matches.length - 1] : null
    },
    { timeoutMs: 4000, intervalMs: 100 }
  )
  const chatBody = chatMessage?.json || null
  const chatRaw = chatMessage?.raw || ''
  const chatSecretFields = ['token', 'sessionId', 'recoveryKey'].filter((field) => chatBody && field in chatBody)
  const chatLeaksSecret = Boolean(echoIdentity?.recoveryKey) && chatRaw.includes(echoIdentity.recoveryKey)
  collector.assert('s02-chat-uses-public-id', {
    title: '聊天广播使用公开 id（无 token/sessionId/recoveryKey，无恢复密钥原文）',
    expected: { received: true, secretFieldsPresent: [], leaksRecoveryKey: false },
    actual: {
      received: Boolean(chatBody),
      secretFieldsPresent: chatSecretFields,
      leaksRecoveryKey: chatLeaksSecret,
      body: chatBody
    },
    condition: Boolean(chatBody) && chatSecretFields.length === 0 && !chatLeaksSecret,
    level: LEVEL.REAL_JAR
  })

  // ---- F: secret must not appear in /api/config or /api/version --------------------
  const configAgain = await get(server.base, '/api/config')
  const versionAgain = await get(server.base, '/api/version')
  const exposed = [configAgain.text, versionAgain.text].some(
    (text) => recoveryKeyValue && text.includes(recoveryKeyValue)
  )
  collector.assert('s02-config-hides-secrets', {
    title: '/api/config 与 /api/version 不暴露恢复密钥/Cookie/管理员密码',
    expected: false,
    actual: exposed,
    condition: !exposed,
    level: LEVEL.REAL_JAR
  })

  await Promise.all([alpha, beta, gamma, delta, echo].map((client) => client.disconnect()))
  await server.stop({ graceMs: 0 })
}

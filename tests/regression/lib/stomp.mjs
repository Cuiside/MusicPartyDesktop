/**
 * Raw STOMP client for protocol-level assertions.
 *
 * Uses @stomp/stompjs directly (not the desktop client) so a test failure is about the
 * server wire behavior, never about renderer/UI logic. All messages on the configured
 * destinations are retained for later assertions (single-cast checks, secret scanning).
 */
import { Client } from '@stomp/stompjs'
import { sleep, waitFor } from './env.mjs'

/** Destinations the verification client listens to by default. */
export const DEFAULT_SUBSCRIPTIONS = [
  '/topic/player/state',
  '/topic/player/queue',
  '/topic/users/online',
  '/topic/player/events',
  '/topic/chat',
  '/user/queue/events',
  '/user/queue/me',
  '/app/user/me',
  '/user/queue/command-ack',
  '/user/queue/pong',
  '/user/queue/chat/history',
  '/user/queue/chat/private'
]

/**
 * @param {{
 *   baseUrl: string,
 *   headers?: Record<string,string>,
 *   subscriptions?: string[],
 *   label?: string,
 *   connectionTimeoutMs?: number
 * }} options
 */
export async function connectStomp(options) {
  const {
    baseUrl,
    headers = {},
    subscriptions = DEFAULT_SUBSCRIPTIONS,
    label = 'stomp-client',
    connectionTimeoutMs = 10000
  } = options
  const brokerURL = `${String(baseUrl).replace(/^http/, 'ws')}/ws`

  /** @type {Map<string, Array<{raw:string,json:any,headers:Record<string,string>,at:number}>>} */
  const inbox = new Map()
  const errors = []
  let connected = false
  let settled = false
  let failure = ''

  const client = new Client({
    brokerURL,
    connectHeaders: headers,
    reconnectDelay: 0,
    connectionTimeout: connectionTimeoutMs,
    heartbeatIncoming: 0,
    heartbeatOutgoing: 0,
    debug: () => {}
  })

  const resolveConnect = (fn) => {
    if (settled) return
    settled = true
    fn()
  }

  const handle = {
    label,
    client,
    inbox,
    errors,
    get connected() {
      return connected
    },
    /** All messages received on a destination. */
    messages(destination) {
      return inbox.get(destination) || []
    },
    /** The last JSON body received on a destination (or undefined). */
    lastJson(destination) {
      const messages = handle.messages(destination)
      if (!messages.length) return undefined
      return messages[messages.length - 1].json
    },
    /** Last raw body (string) received on a destination. */
    lastRaw(destination) {
      const messages = handle.messages(destination)
      return messages.length ? messages[messages.length - 1].raw : undefined
    },
    /** Wait for the first message on `destination` matching `predicate` (JSON body). */
    async waitJson(destination, predicate = () => true, timeoutMs = 3000) {
      return await waitFor(
        () => {
          const match = handle.messages(destination).find((message) => {
            try {
              return predicate(message.json, message)
            } catch {
              return false
            }
          })
          return match ? match.json : null
        },
        { timeoutMs, intervalMs: 50 }
      )
    },
    /** Count messages on `destination` matching predicate. */
    count(destination, predicate = () => true) {
      return handle.messages(destination).filter((message) => {
        try {
          return predicate(message.json, message)
        } catch {
          return false
        }
      }).length
    },
    /** Publish a JSON command. */
    send(destination, body, extraHeaders = {}) {
      const payload = body === undefined ? '{}' : JSON.stringify(body)
      client.publish({ destination, body: payload, headers: extraHeaders })
    },
    /** Subscribe an extra destination after connect. */
    subscribe(destination) {
      inbox.set(destination, inbox.get(destination) || [])
      client.subscribe(destination, (frame) => {
        const entry = {
          raw: frame.body,
          json: safeParse(frame.body),
          headers: { ...(frame.headers || {}) },
          at: Date.now()
        }
        inbox.set(destination, [...(inbox.get(destination) || []), entry])
      })
      return destination
    },
    /** All raw bodies observed on every subscribed destination (for secret scans). */
    allRawBodies() {
      const out = []
      for (const [destination, messages] of inbox.entries()) {
        for (const message of messages) out.push({ destination, ...message })
      }
      return out
    },
    async disconnect() {
      try {
        await client.deactivate()
      } catch {
        /* already closed */
      }
    }
  }

  client.onConnect = () => {
    connected = true
    for (const destination of subscriptions) handle.subscribe(destination)
    resolveConnect(() => {})
  }
  client.onStompError = (frame) => {
    errors.push(`STOMP ERROR ${frame?.headers?.message || ''} ${frame?.body || ''}`.trim())
    if (!connected) resolveConnect(() => (failure = errors[errors.length - 1]))
  }
  client.onWebSocketError = (event) => {
    errors.push(`WS ERROR ${event?.message || event?.type || 'unknown'}`)
    if (!connected) resolveConnect(() => (failure = errors[errors.length - 1]))
  }
  client.onWebSocketClose = (event) => {
    if (!connected && !settled) resolveConnect(() => (failure = `WS CLOSED code=${event?.code} reason=${event?.reason || ''}`))
  }

  client.activate()
  await new Promise((resolve) => {
    if (settled) return resolve()
    const timer = setTimeout(() => {
      if (!settled) {
        failure = `STOMP connect timeout after ${connectionTimeoutMs}ms`
        resolveConnect(() => {})
      }
      resolve()
    }, connectionTimeoutMs + 500)
    const poll = setInterval(() => {
      if (settled) {
        clearInterval(poll)
        clearTimeout(timer)
        resolve()
      }
    }, 25)
  })

  if (!connected) {
    try {
      await client.deactivate()
    } catch {
      /* ignore */
    }
    throw new Error(`STOMP 连接失败（${label}）：${failure || errors.join('; ') || 'unknown'}`)
  }
  return handle
}

/** Attempt a connection and return {ok, error} instead of throwing (rate-limit tests). */
export async function tryConnectStomp(options) {
  try {
    const handle = await connectStomp({ ...options, connectionTimeoutMs: options?.connectionTimeoutMs || 6000 })
    return { ok: true, handle }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** Convenience: connect, send one ping, wait for the pong (D-06). */
export async function pingPong(handle, { requestId, clientTime, timeoutMs = 3000 } = {}) {
  const payload = { requestId, clientTime }
  handle.send('/app/ping', payload)
  return await handle.waitJson('/user/queue/pong', (json) => json?.requestId === requestId, timeoutMs)
}

/** Publish an enqueue command with a requestId and wait for its ack (D-15). */
export async function enqueueAndAck(handle, { musicId, platform = 'netease', requestId, timeoutMs = 3000 } = {}) {
  handle.send('/app/enqueue', { platform, musicId, requestId })
  return await handle.waitJson('/user/queue/command-ack', (json) => json?.requestId === requestId, timeoutMs)
}

/** Rename to a member nickname (all non-reserved names become members). */
export async function renameToMember(handle, name, requestId) {
  handle.send('/app/user/rename', { newName: name, ...(requestId ? { requestId } : {}) })
  return await waitFor(() => handle.messages('/topic/users/online').length > 0, { timeoutMs: 3000 })
}

function safeParse(body) {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export { sleep }

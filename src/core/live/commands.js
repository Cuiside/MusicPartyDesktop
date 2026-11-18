/**
 * Command channel with optional protocol-v2 acknowledgement (D-15).
 *
 * Protocol v2 servers may advertise the `command-ack` capability in `/api/config`.
 * When present, every command body carries a `requestId` and the server answers with
 * a point-to-point `/user/queue/command-ack` frame:
 *
 * ```json
 * { "requestId": "…", "destination": "/app/enqueue", "ok": true,
 *   "code": "OK", "message": "", "retryAfterMs": null }
 * ```
 *
 * The channel turns "STOMP publish happened" into a structured result:
 *
 * - `{ ok: true, confirmed: true, code: 'OK' }` — server explicitly accepted;
 * - `{ ok: false, confirmed: true, code: 'COOLDOWN', message, retryAfterMs }` — rejected;
 * - `{ ok: true, confirmed: false, code: 'UNCONFIRMED' }` — old server (no capability)
 *   or the ack timed out; the UI must show "已发送（未确认）", never a fake success.
 *
 * The module is deliberately dependency-free (publish function, capability check and
 * timers are injected) so it can be unit-tested without STOMP/Electron.
 *
 * @module core/live/commands
 */

/** Default ack wait: the protocol allows the UI to show "已发送（等待确认）" meanwhile. */
export const DEFAULT_ACK_TIMEOUT_MS = 1500

/** Human-readable fallback messages for the protocol code set. */
export const ACK_CODE_MESSAGES = {
  OK: '',
  GUEST: '游客身份不能执行该操作，请先设置昵称成为成员',
  COOLDOWN: '操作太频繁，请稍后再试',
  LOCKED: '该操作已被房间锁定',
  QUEUE_FULL: '播放队列已满',
  DUPLICATE: '这首歌已经在队列中或重复提交',
  INVALID: '请求参数无效',
  UPSTREAM: '上游服务暂时不可用'
}

/**
 * @typedef {Object} CommandResult
 * @property {boolean} ok Server accepted / command published (false on rejection).
 * @property {boolean} confirmed The server sent an explicit ACK for this request.
 * @property {string} [code] `OK | GUEST | COOLDOWN | LOCKED | QUEUE_FULL | DUPLICATE | INVALID | UPSTREAM | OFFLINE | INVALID_LOCAL | UNCONFIRMED`
 * @property {string} [message] Server-provided message (fallback: {@link ACK_CODE_MESSAGES}).
 * @property {number} [retryAfterMs] Cooldown hint from the server.
 * @property {string} [reason] User-presentable reason for local rejects / unconfirmed.
 * @property {string} [requestId] Request id used for the ACK (empty for old servers).
 */

/**
 * Generate a request id (UUID when the runtime supports it, random fallback otherwise).
 * @returns {string}
 */
export function defaultRequestId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid
  } catch {
    /* crypto unavailable */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const value = (Math.random() * 16) | 0
    return (ch === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

/**
 * Build the user-facing message for an ACK code.
 * @param {string} code
 * @param {string} [serverMessage]
 * @returns {string}
 */
export function ackMessage(code, serverMessage) {
  const fromServer = String(serverMessage ?? '').trim()
  if (fromServer) return fromServer
  return ACK_CODE_MESSAGES[String(code ?? '').toUpperCase()] || ''
}

/**
 * Create a command channel.
 *
 * @param {Object} options
 * @param {(destination: string, body: Record<string, any>) => void} options.publish
 *   Sends the STOMP SEND frame; may throw when the transport is not usable.
 * @param {() => boolean} options.isConnected
 * @param {(name: string) => boolean} [options.hasCapability]
 * @param {number} [options.ackTimeoutMs]
 * @param {() => string} [options.requestIdFactory]
 * @param {(fn: () => void, ms: number) => any} [options.schedule]
 * @param {(timer: any) => void} [options.cancel]
 * @returns {{ send: (destination: string, body?: Record<string, any>) => Promise<CommandResult>,
 *   handleAck: (payload: any) => boolean, rejectAll: (reason: string) => void,
 *   pendingCount: () => number }}
 */
export function createCommandChannel(options = {}) {
  const publish = typeof options.publish === 'function' ? options.publish : () => {}
  const isConnected = typeof options.isConnected === 'function' ? options.isConnected : () => false
  const hasCapability = typeof options.hasCapability === 'function' ? options.hasCapability : () => false
  const ackTimeoutMs = Number(options.ackTimeoutMs) > 0 ? Number(options.ackTimeoutMs) : DEFAULT_ACK_TIMEOUT_MS
  const requestIdFactory = typeof options.requestIdFactory === 'function' ? options.requestIdFactory : defaultRequestId
  const schedule = typeof options.schedule === 'function' ? options.schedule : (fn, ms) => setTimeout(fn, ms)
  const cancel = typeof options.cancel === 'function' ? options.cancel : (timer) => clearTimeout(timer)

  /** @type {Map<string, { resolve: (result: CommandResult) => void, timer: any, destination: string }>} */
  const pending = new Map()

  /**
   * Publish one command.
   * @param {string} destination e.g. `/app/enqueue`
   * @param {Record<string, any>} [body]
   * @returns {Promise<CommandResult>}
   */
  async function send(destination, body) {
    if (!isConnected()) {
      return { ok: false, confirmed: false, code: 'OFFLINE', reason: '连接已断开，命令未发送' }
    }
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {}
    const wantsAck = hasCapability('command-ack')
    const requestId = wantsAck ? String(requestIdFactory() || '') : ''
    if (requestId) payload.requestId = requestId
    try {
      publish(destination, payload)
    } catch (error) {
      return {
        ok: false,
        confirmed: false,
        code: 'OFFLINE',
        reason: `命令发送失败：${String(error?.message || error)}`
      }
    }
    if (!wantsAck || !requestId) {
      return { ok: true, confirmed: false, code: 'UNCONFIRMED', reason: '已发送（未确认）', requestId: '' }
    }
    return new Promise((resolve) => {
      const timer = schedule(() => {
        if (!pending.has(requestId)) return
        pending.delete(requestId)
        resolve({ ok: true, confirmed: false, code: 'UNCONFIRMED', reason: '已发送（未确认）', requestId })
      }, ackTimeoutMs)
      pending.set(requestId, { resolve, timer, destination })
    })
  }

  /**
   * Handle one `/user/queue/command-ack` frame.
   * @param {any} payload
   * @returns {boolean} true when the frame matched a pending command.
   */
  function handleAck(payload) {
    if (!payload || typeof payload !== 'object') return false
    const requestId = String(payload.requestId ?? '')
    if (!requestId) return false
    const entry = pending.get(requestId)
    if (!entry) return false
    pending.delete(requestId)
    cancel(entry.timer)
    const code = String(payload.code ?? (payload.ok ? 'OK' : 'INVALID')).toUpperCase()
    const ok = payload.ok === true || payload.success === true || code === 'OK'
    const message = ackMessage(code, payload.message)
    const retryAfterMs = Number(payload.retryAfterMs)
    entry.resolve({
      ok,
      confirmed: true,
      code,
      message: ok ? '' : message,
      retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined,
      reason: ok ? undefined : message || `操作被服务器拒绝（${code}）`,
      requestId,
      destination: String(payload.destination || entry.destination || '')
    })
    return true
  }

  /**
   * Resolve every pending command as failed (connection closed / session teardown).
   * @param {string} [reason]
   * @returns {void}
   */
  function rejectAll(reason = '连接已关闭，命令未确认') {
    if (!pending.size) return
    const entries = [...pending.values()]
    pending.clear()
    entries.forEach((entry) => {
      cancel(entry.timer)
      entry.resolve({ ok: false, confirmed: false, code: 'OFFLINE', reason })
    })
  }

  /** Number of commands currently waiting for an ACK (tests / diagnostics). */
  function pendingCount() {
    return pending.size
  }

  return { send, handleAck, rejectAll, pendingCount }
}

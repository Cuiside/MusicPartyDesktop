/**
 * Thin HTTP helpers for the regression suite (no dependencies, fetch based).
 * Every request has a bounded timeout so a broken endpoint can never hang a suite.
 */
import { sleep } from './env.mjs'

export function parseJsonSafe(text) {
  if (text === undefined || text === null) return null
  const trimmed = String(text).trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * Perform one HTTP request. Returns {status, headers, text, json, error, durationMs}.
 * `json` is null when the body is not valid JSON.
 */
export async function request(base, apiPath, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = 8000,
    redirect = 'follow',
    rawBody = false
  } = options
  const url = `${String(base).replace(/\/+$/, '')}${apiPath}`
  const finalHeaders = { Accept: 'application/json', ...headers }
  let payload
  if (body !== undefined) {
    payload = rawBody ? String(body) : JSON.stringify(body)
    if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json'
  }
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      redirect,
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json: parseJsonSafe(text),
      durationMs: Date.now() - startedAt,
      url
    }
  } catch (error) {
    return {
      status: 0,
      headers: {},
      text: '',
      json: null,
      error: String(error?.message || error),
      durationMs: Date.now() - startedAt,
      url
    }
  }
}

export const get = (base, apiPath, options = {}) => request(base, apiPath, { ...options, method: 'GET' })
export const post = (base, apiPath, body, options = {}) =>
  request(base, apiPath, { ...options, method: 'POST', body })

/** Authenticated admin request with the synthetic fixture password. */
export function adminRequest(base, apiPath, body, { password, method = 'POST', ...options } = {}) {
  const headers = { 'X-Admin-Password': String(password ?? ''), ...(options.headers || {}) }
  return request(base, apiPath, { ...options, method, body, headers })
}

/** REST request carrying a room token (S-07). */
export function roomRequest(base, apiPath, roomToken, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (roomToken !== undefined && roomToken !== null) headers['X-Room-Token'] = String(roomToken)
  return request(base, apiPath, { ...options, headers })
}

/** REST request carrying a room token (S-07). */
export function withRoomToken(base, apiPath, roomToken, options = {}) {
  return roomRequest(base, apiPath, roomToken, options)
}

/** Poll until `fn` returns truthy; returns the value or null. */
export async function waitForValue(fn, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const started = Date.now()
  for (;;) {
    let value = null
    try {
      value = await fn()
    } catch {
      value = null
    }
    if (value) return value
    if (Date.now() - started >= timeoutMs) return null
    await sleep(intervalMs)
  }
}

/** True when an HTTP body leaks internal Java / Jackson implementation details. */
export function leaksInternalDetail(text) {
  const value = String(text ?? '')
  return /Cannot invoke|NullPointerException|com\.fasterxml|java\.lang\.|JsonNode|org\.springframework|StackTrace|at org\.|Exception:/i.test(
    value
  )
}

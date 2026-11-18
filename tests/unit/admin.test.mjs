/**
 * D-08 单元测试：管理员认证绑定不可变服务器 base，跨 base 请求必须本地拒绝并清除凭据。
 * 同时验证 A→B、同域不同路径、A→B→A、重定向拒绝。
 *
 * 运行：node --test tests/unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADMIN_ERROR_SERVER_CHANGED,
  ADMIN_ERROR_REDIRECT,
  adminAuth,
  adminLogout,
  adminRequest,
  isAdminSessionFor,
  verifyAdmin
} from '../../src/core/live/admin.js'
import { beginSession, endSession } from '../../src/core/live/session.js'
import { saveSettings } from '../../src/core/live/config.js'

/** 记录所有 fetch 调用，返回可配置的响应。 */
function stubFetch(responder) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers || {}, redirect: options?.redirect })
    return responder(String(url), options)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    }
  }
}

/** 构造一个最小 fetch Response。 */
function jsonResponse(body, status = 200, extra = {}) {
  return {
    status,
    redirected: Boolean(extra.redirected),
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    ...extra
  }
}

test('A→B：认证绑定 A 后向 B 发请求必须失败且不发送旧密码（D-08）', async () => {
  endSession()
  adminLogout()
  saveSettings({ serverUrl: 'http://127.0.0.1:18848' })
  const stub = stubFetch(() => jsonResponse({ message: 'ok' }))
  try {
    beginSession('http://127.0.0.1:18848')
    const verified = await verifyAdmin('synthetic-admin-pass')
    assert.equal(verified, true)
    assert.equal(adminAuth.authenticatedServerBase, 'http://127.0.0.1:18848')
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].url, 'http://127.0.0.1:18848/api/admin/verify')
    assert.equal(stub.calls[0].headers['X-Admin-Password'], 'synthetic-admin-pass')

    // 目标换成 B（不同端口）——应在本地被拒绝，B 不应收到任何请求/凭据。
    await assert.rejects(
      () => adminRequest('POST', '/api/admin/config/cookie', { platform: 'netease', value: 'x' }, { base: 'http://127.0.0.1:18849' }),
      (error) => error.message === ADMIN_ERROR_SERVER_CHANGED
    )
    assert.equal(stub.calls.length, 1, 'B 不得收到任何请求')
    assert.equal(adminAuth.verified, false, '跨 base 后必须清除认证状态')
    assert.equal(adminAuth.password, '')
    assert.equal(adminAuth.authenticatedServerBase, '')
  } finally {
    stub.restore()
    endSession()
    adminLogout()
  }
})

test('同域不同路径前缀视为不同服务器', async () => {
  endSession()
  adminLogout()
  const stub = stubFetch(() => jsonResponse({ message: 'ok' }))
  try {
    beginSession('https://music.example.com/gatewayA')
    assert.equal(await verifyAdmin('pw-A'), true)
    await assert.rejects(
      () => adminRequest('POST', '/api/admin/lock', { type: 'PAUSE', locked: true }, { base: 'https://music.example.com/gatewayB' }),
      (error) => error.message === ADMIN_ERROR_SERVER_CHANGED
    )
    assert.equal(stub.calls.length, 1)
    assert.equal(adminAuth.verified, false)
  } finally {
    stub.restore()
    endSession()
    adminLogout()
  }
})

test('A→B→A：切回 A 也必须重新认证，不自动复用旧密码', async () => {
  endSession()
  adminLogout()
  const stub = stubFetch(() => jsonResponse({ message: 'ok' }))
  try {
    beginSession('http://127.0.0.1:18848')
    assert.equal(await verifyAdmin('pw-A'), true)
    await assert.rejects(
      () => adminRequest('POST', '/api/admin/lock', {}, { base: 'http://127.0.0.1:18849' }),
      (error) => error.message === ADMIN_ERROR_SERVER_CHANGED
    )
    // 再切回 A：未重新认证时不得发送命令。
    await assert.rejects(
      () => adminRequest('POST', '/api/admin/lock', {}, { base: 'http://127.0.0.1:18848' }),
      (error) => /请先完成管理员认证/.test(error.message)
    )
    assert.equal(stub.calls.length, 1, '失败路径不得发出任何携带旧密码的请求')
    assert.equal(adminAuth.password, '')
  } finally {
    stub.restore()
    endSession()
    adminLogout()
  }
})

test('verify 成功后仅绑定目标 base；isAdminSessionFor 精确匹配', async () => {
  endSession()
  adminLogout()
  const stub = stubFetch(() => jsonResponse({ message: 'ok' }))
  try {
    beginSession('http://127.0.0.1:18848')
    assert.equal(await verifyAdmin('pw', 'https://music.example.com/prefix'), true)
    assert.equal(isAdminSessionFor('https://music.example.com/prefix'), true)
    assert.equal(isAdminSessionFor('https://music.example.com'), false)
    // 存续的认证在目标匹配时正常发出。
    const response = await adminRequest('POST', '/api/admin/lock', { type: 'PAUSE', locked: true }, {
      base: 'https://music.example.com/prefix'
    })
    assert.equal(response.message, 'ok')
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[1].url, 'https://music.example.com/prefix/api/admin/lock')
    assert.equal(stub.calls[1].headers['X-Admin-Password'], 'pw')
  } finally {
    stub.restore()
    endSession()
    adminLogout()
  }
})

test('重定向被拒绝：认证请求遇到 30x 不得视为成功', async () => {
  adminLogout()
  const stub = stubFetch(() => jsonResponse({ message: 'moved' }, 302, { redirected: true }))
  try {
    const ok = await verifyAdmin('pw', 'https://music.example.com')
    assert.equal(ok, false)
    assert.equal(adminAuth.verified, false)
    assert.equal(adminAuth.error, ADMIN_ERROR_REDIRECT)
  } finally {
    stub.restore()
    adminLogout()
  }
})

test('本地先拒绝空密码（D-09 客户端侧）', async () => {
  adminLogout()
  const stub = stubFetch(() => jsonResponse({ message: 'should-not-be-called' }))
  try {
    assert.equal(await verifyAdmin(''), false)
    assert.equal(adminAuth.error, '请输入管理员密码')
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
    adminLogout()
  }
})

test('仅保存 settings 新地址（未 teardown）时管理员请求仍打当前会话 base A', async () => {
  endSession()
  adminLogout()
  saveSettings({ serverUrl: 'http://127.0.0.1:18848' })
  const stub = stubFetch(() => jsonResponse({ message: 'ok' }))
  try {
    beginSession('http://127.0.0.1:18848')
    assert.equal(await verifyAdmin('pw-session'), true)
    // 模拟 Settings 编辑并保存了新地址，但当前会话尚未切换（session base 仍为 A）。
    saveSettings({ serverUrl: 'http://127.0.0.1:18849' })
    await adminRequest('POST', '/api/admin/lock', { type: 'PAUSE', locked: true })
    const last = stub.calls[stub.calls.length - 1]
    assert.ok(
      last.url.startsWith('http://127.0.0.1:18848/'),
      `管理员请求必须使用会话 base A，实际：${last.url}`
    )
    assert.equal(last.headers['X-Admin-Password'], 'pw-session')
    assert.equal(stub.calls.filter((call) => call.url.includes('18849')).length, 0, 'B 不得收到旧密码')
  } finally {
    stub.restore()
    endSession()
    adminLogout()
  }
})

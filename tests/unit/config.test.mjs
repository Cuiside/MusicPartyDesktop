/**
 * D-02/D-12 单元测试：服务器地址规范化（裸域名 / 回环 / 私网 / 显式协议 / 路径前缀 / ws）。
 *
 * 运行：node --test tests/unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SERVER,
  normalizeServerUrl,
  parseServerUrl,
  httpBase,
  wsUrl,
  serverHost,
  isPrivateOrLoopbackHost,
  saveSettings,
  loadSettings
} from '../../src/core/live/config.js'
import { beginSession, sessionAddress, endSession, activeBase } from '../../src/core/live/session.js'
import { verifyRoomAccess } from '../../src/core/live/api.js'

test('裸公网域名默认 https（D-02）', () => {
  assert.equal(normalizeServerUrl('music.example.com'), 'https://music.example.com')
  assert.equal(normalizeServerUrl('music.example.com/prefix'), 'https://music.example.com/prefix')
})

test('回环地址默认 http', () => {
  assert.equal(normalizeServerUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(normalizeServerUrl('localhost:18848'), 'http://localhost:18848')
  assert.equal(normalizeServerUrl('[::1]:8080'), 'http://[::1]:8080')
  assert.equal(normalizeServerUrl('::1'), '', '裸 ::1 不是合法 host 写法应报错而非回退')
})

test('私网地址默认 http，公网私网边界之外默认 https', () => {
  assert.equal(normalizeServerUrl('192.168.1.5:8080'), 'http://192.168.1.5:8080')
  assert.equal(normalizeServerUrl('10.1.2.3'), 'http://10.1.2.3')
  assert.equal(normalizeServerUrl('172.20.0.9:9000'), 'http://172.20.0.9:9000')
  assert.equal(normalizeServerUrl('172.32.0.9'), 'https://172.32.0.9')
  assert.equal(isPrivateOrLoopbackHost('127.0.0.1'), true)
  assert.equal(isPrivateOrLoopbackHost('192.168.0.2'), true)
  assert.equal(isPrivateOrLoopbackHost('music.example.com'), false)
})

test('显式 https / http / ws / wss 被尊重，ws 映射成 http', () => {
  assert.equal(normalizeServerUrl('https://music.example.com'), 'https://music.example.com')
  assert.equal(normalizeServerUrl('http://music.example.com:8080'), 'http://music.example.com:8080')
  assert.equal(normalizeServerUrl('wss://music.example.com/ws'), 'https://music.example.com')
  assert.equal(normalizeServerUrl('ws://127.0.0.1:8080/ws'), 'http://127.0.0.1:8080')
  assert.equal(normalizeServerUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
})

test('保留完整路径前缀并去掉尾部 /ws（D-12）', () => {
  assert.equal(normalizeServerUrl('https://music.example.com/prefix/'), 'https://music.example.com/prefix')
  assert.equal(normalizeServerUrl('https://music.example.com/prefix/ws'), 'https://music.example.com/prefix')
  assert.equal(normalizeServerUrl('http://host:8080/a/b/'), 'http://host:8080/a/b')
  assert.equal(normalizeServerUrl('http://host:8080//a//b'), 'http://host:8080/a/b')
})

test('无效输入返回空串并给出可读错误，绝不静默回退 localhost', () => {
  for (const input of ['', '   ', 'not a url', 'ftp://host', 'http://', 'http://host:99999', 'user:pass@host:80']) {
    assert.equal(normalizeServerUrl(input), '', `应拒绝：${JSON.stringify(input)}`)
    const parsed = parseServerUrl(input)
    assert.equal(parsed.ok, false, `parseServerUrl 应返回错误：${JSON.stringify(input)}`)
    assert.ok(parsed.error && parsed.error.length > 3, '错误信息应可读')
  }
  const ok = parseServerUrl('music.example.com')
  assert.equal(ok.ok, true)
  assert.equal(ok.url, 'https://music.example.com')
  assert.equal(ok.scheme, 'https')
})

test('httpBase / wsUrl / serverHost 从完整 base 推导，不丢路径前缀', () => {
  assert.equal(httpBase('https://music.example.com/prefix'), 'https://music.example.com/prefix')
  assert.equal(wsUrl('https://music.example.com/prefix'), 'wss://music.example.com/prefix/ws')
  assert.equal(wsUrl('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/ws')
  assert.equal(serverHost('https://music.example.com/prefix'), 'music.example.com')
  assert.equal(
    httpBase('garbage input'),
    loadSettings().serverUrl,
    'httpBase 无效显式入参时退回已保存地址（不静默回退 localhost）'
  )
})

test('saveSettings 拒绝非法地址但保留已保存地址', () => {
  saveSettings({ serverUrl: 'https://music.example.com/gateway' })
  const before = loadSettings().serverUrl
  assert.equal(before, 'https://music.example.com/gateway')
  const saved = saveSettings({ serverUrl: 'bad address with spaces' })
  assert.equal(saved.serverUrl, before, '非法地址不得覆盖已保存地址')
})

test('session base：连接时固化，保存新地址不改变当前会话，复制地址等于 session base（D-12/D-16）', () => {
  endSession()
  beginSession('music.example.com/prefix')
  const frozen = activeBase()
  assert.equal(frozen, 'https://music.example.com/prefix')
  // 保存另一个地址只影响“下次连接”，不得改变当前会话 base。
  saveSettings({ serverUrl: 'http://127.0.0.1:18849' })
  assert.equal(activeBase(), 'https://music.example.com/prefix')
  assert.equal(sessionAddress(), 'https://music.example.com/prefix', '复制地址应使用完整会话 base')
  endSession()
  assert.equal(activeBase(), 'http://127.0.0.1:18849', '会话结束后回落到下次连接地址')
})

test('连接后 HTTP 请求使用会话 base，不会因保存 settings 新地址而发到 B（D-16 不串服务器）', async () => {
  endSession()
  beginSession('https://music.example.com/gateway')
  // 模拟用户“改了设置地址但尚未重连/尚未切换”的中间态。
  saveSettings({ serverUrl: 'http://127.0.0.1:18849' })
  const calls = []
  // 模拟 Electron preload 的 HTTP bridge（api.js 在存在 bridge 时走它，Node 下否则走 axios）。
  globalThis.window = {
    mpDesktop: {
      http: {
        request: async (options) => {
          calls.push(String(options.url))
          throw new Error('offline-test')
        }
      }
    }
  }
  try {
    const result = await verifyRoomAccess('')
    assert.equal(result.ok, true)
    assert.equal(result.skipped, true, 'REST 不可达时按既有设计跳过，由 STOMP CONNECT 兜底')
  } finally {
    delete globalThis.window
  }
  assert.ok(calls.length >= 1)
  assert.ok(
    calls.every((url) => url.startsWith('https://music.example.com/gateway/')),
    `所有 HTTP 必须打到会话 base，实际：${calls.join(', ')}`
  )
  endSession()
})

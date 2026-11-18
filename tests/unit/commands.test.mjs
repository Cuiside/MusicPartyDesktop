/**
 * D-15 单元测试：命令 requestId + command-ack（成功 / 超时 / 拒绝 / 冷却 / 旧服务端降级）。
 *
 * 运行：node --test tests/unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createCommandChannel, ACK_CODE_MESSAGES } from '../../src/core/live/commands.js'

/** 构造一个可控的 channel + 记录发送内容 + 可手动触发的定时器。 */
function setup(options = {}) {
  const sent = []
  const timers = []
  const channel = createCommandChannel({
    publish: (destination, body) => sent.push({ destination, body }),
    isConnected: () => options.connected !== false,
    hasCapability: (name) => (options.capabilities || []).includes(name),
    ackTimeoutMs: options.ackTimeoutMs || 1500,
    requestIdFactory: () => 'req-fixed',
    schedule: (fn) => {
      timers.push(fn)
      return fn
    },
    cancel: (timer) => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    }
  })
  return { channel, sent, timers }
}

test('旧服务端（无 command-ack）：立即返回“已发送（未确认）”，不带 requestId', async () => {
  const { channel, sent } = setup({ capabilities: [] })
  const result = await channel.send('/app/enqueue', { musicId: 'm1' })
  assert.equal(result.ok, true)
  assert.equal(result.confirmed, false)
  assert.equal(result.code, 'UNCONFIRMED')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.requestId, undefined, '旧服务端不应收到 requestId')
})

test('新服务端 ACK OK：返回 confirmed:true + code OK', async () => {
  const { channel, sent } = setup({ capabilities: ['command-ack'] })
  const promise = channel.send('/app/enqueue', { musicId: 'm1' })
  assert.equal(sent[0].destination, '/app/enqueue')
  assert.equal(sent[0].body.requestId, 'req-fixed')
  const matched = channel.handleAck({
    requestId: 'req-fixed',
    destination: '/app/enqueue',
    ok: true,
    code: 'OK',
    message: '',
    retryAfterMs: null
  })
  assert.equal(matched, true)
  const result = await promise
  assert.deepEqual(
    { ok: result.ok, confirmed: result.confirmed, code: result.code },
    { ok: true, confirmed: true, code: 'OK' }
  )
})

test('ACK 超时：显示“已发送（未确认）”，不伪造成功', async () => {
  const { channel, timers } = setup({ capabilities: ['command-ack'] })
  const promise = channel.send('/app/chat', { content: 'hi' })
  assert.equal(channel.pendingCount(), 1)
  timers[0]() // 触发 1500ms 超时
  const result = await promise
  assert.equal(result.ok, true)
  assert.equal(result.confirmed, false)
  assert.equal(result.code, 'UNCONFIRMED')
  assert.equal(result.reason, '已发送（未确认）')
  assert.equal(channel.pendingCount(), 0)
})

test('ACK 拒绝 + 冷却：返回 ok:false / code / retryAfterMs（D-15 冷却剩余秒）', async () => {
  const { channel, sent } = setup({ capabilities: ['command-ack'] })
  const promise = channel.send('/app/enqueue', { musicId: 'm1' })
  channel.handleAck({
    requestId: sent[0].body.requestId,
    destination: '/app/enqueue',
    ok: false,
    code: 'COOLDOWN',
    message: '',
    retryAfterMs: 1500
  })
  const result = await promise
  assert.equal(result.ok, false)
  assert.equal(result.confirmed, true)
  assert.equal(result.code, 'COOLDOWN')
  assert.equal(result.retryAfterMs, 1500)
  assert.equal(result.reason, ACK_CODE_MESSAGES.COOLDOWN)
})

test('ACK GUEST / LOCKED / QUEUE_FULL 有可读中文原因', async () => {
  const { channel, sent } = setup({ capabilities: ['command-ack'] })
  for (const code of ['GUEST', 'LOCKED', 'QUEUE_FULL', 'DUPLICATE', 'INVALID', 'UPSTREAM']) {
    const promise = channel.send('/app/chat', { content: code })
    channel.handleAck({ requestId: sent[sent.length - 1].body.requestId, ok: false, code })
    const result = await promise
    assert.equal(result.ok, false, `${code} 应失败`)
    assert.equal(result.code, code)
    assert.ok(result.reason && result.reason.length > 2, `${code} 应有中文原因`)
  }
})

test('旧服务端 ack 缺失/未知 requestId 不误配', async () => {
  const { channel } = setup({ capabilities: ['command-ack'] })
  const promise = channel.send('/app/like', { position: 1 })
  assert.equal(channel.handleAck({ requestId: 'other', ok: true }), false)
  assert.equal(channel.handleAck(null), false)
  // 仍等待原请求：手动收尾，避免悬挂。
  channel.rejectAll('测试结束')
  const result = await promise
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OFFLINE')
})

test('断线时 send 返回 OFFLINE 且不 publish', async () => {
  const { channel, sent } = setup({ connected: false, capabilities: ['command-ack'] })
  const result = await channel.send('/app/enqueue', { musicId: 'm1' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OFFLINE')
  assert.equal(sent.length, 0)
})

test('publish 抛错时返回结构化失败而非抛出', async () => {
  const channel = createCommandChannel({
    publish: () => {
      throw new Error('socket closed')
    },
    isConnected: () => true,
    hasCapability: () => true,
    requestIdFactory: () => 'r1'
  })
  const result = await channel.send('/app/enqueue', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OFFLINE')
  assert.match(result.reason, /命令发送失败/)
})

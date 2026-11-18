/**
 * D-15 单元测试：客户端游客门禁（addToQueue / sendChat / 播放控制 / like / pin 等必须本地拒绝，
 * 返回结构化 {ok:false, code:'GUEST', reason}，不得假报成功）。
 *
 * 运行：node --test tests/unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { live } from '../../src/core/live/state.js'
import {
  addToQueue,
  joinRoom,
  like,
  pin,
  removeFromQueue,
  sendChat,
  skip,
  togglePlay,
  voteSkip,
  rename,
  isGuestLikeName
} from '../../src/core/live/client.js'

/** 恢复成“已连接成员”基线。 */
function memberConnected() {
  live.connected = true
  live.joined = true
  live.identity = { id: 'public-id', name: '成员', isGuest: false }
  live.nowPlaying = {
    id: 'song-1',
    source: 'netease',
    title: 't',
    duration: 100,
    playableDuration: 100,
    cover: {}
  }
  live.queue = [{ id: 'song-1', queueId: 'q1', source: 'netease' }]
  live.config = { maxChatMessageLength: 200 }
}

const guestConnected = () => {
  memberConnected()
  live.identity = { id: 'guest-id', name: '游客', isGuest: true }
}

test('游客：点歌/聊天/播放控制/点赞/置顶/移除全部本地拒绝', async () => {
  guestConnected()
  const results = {
    addToQueue: await addToQueue({ id: 'song-2', source: 'netease' }),
    sendChat: await sendChat('你好'),
    togglePlay: await togglePlay(true),
    skip: await skip(),
    voteSkip: await voteSkip(),
    like: await like(),
    pin: await pin('q1'),
    removeFromQueue: await removeFromQueue('q1')
  }
  for (const [name, result] of Object.entries(results)) {
    assert.equal(result.ok, false, `${name} 游客不得假报成功`)
    assert.equal(result.code, 'GUEST', `${name} 应返回 GUEST`)
    assert.equal(result.reason, '请先设置昵称成为成员')
    assert.equal(result.confirmed, false)
  }
})

test('游客设置昵称（rename）是允许的——这是成为成员的路径', async () => {
  guestConnected()
  const result = await rename('新昵称')
  // 未建立 STOMP 连接，因此是 OFFLINE 而非 GUEST；重点是不被游客门禁拦截。
  assert.equal(result.code, 'OFFLINE')
})

test('昵称前置校验：空 / 游客 / guest 开头被本地拒绝（不发送）', async () => {
  memberConnected()
  assert.equal((await rename('')).code, 'INVALID')
  assert.equal((await rename('游客')).code, 'INVALID')
  assert.equal((await rename('Guest123')).code, 'INVALID')
  assert.equal(isGuestLikeName('游客'), true)
  assert.equal(isGuestLikeName('guest_abc'), true)
  assert.equal(isGuestLikeName('真实昵称'), false)
})

test('断线时所有命令返回 OFFLINE，不假报成功', async () => {
  memberConnected()
  live.connected = false
  for (const result of [
    await addToQueue({ id: 'song-2', source: 'netease' }),
    await sendChat('hi'),
    await togglePlay(true),
    await skip(),
    await pin('q1')
  ]) {
    assert.equal(result.ok, false)
    assert.equal(result.code, 'OFFLINE')
  }
})

test('成员：参数错误返回 INVALID（不会误发命令）', async () => {
  memberConnected()
  assert.equal((await addToQueue(''))?.code, 'INVALID')
  assert.equal((await addToQueue({ id: '' }))?.code, 'INVALID')
  assert.equal((await sendChat('   ')).code, 'INVALID')
  assert.equal((await pin('missing-queue-id')).code, 'INVALID')
  assert.equal((await removeFromQueue('missing-queue-id')).code, 'INVALID')
  // 播放状态不变时明确 NOOP，而不是假装发送。
  live.playing = true
  assert.equal((await togglePlay(true)).code, 'NOOP')
})

test('joinRoom 无效地址：明确报错、不静默回退 localhost、不建立会话（D-02）', async () => {
  live.connected = false
  live.joined = false
  live.sessionBase = ''
  const ok = await joinRoom({ serverUrl: 'not a url', name: 'x' })
  assert.equal(ok, false)
  assert.match(live.error || '', /服务器地址无效/)
  assert.equal(live.sessionBase, '', '无效地址不得固化会话 base')
  assert.equal(live.joined, false)
})

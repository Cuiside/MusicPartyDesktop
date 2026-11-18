/**
 * D-13 单元测试：歌词请求竞态（slow/fast、旧失败、离开房间）与当前歌曲归属校验。
 *
 * 运行：node --test tests/unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { live } from '../../src/core/live/state.js'
import { fetchLyrics, invalidateLyrics } from '../../src/core/live/api.js'
import { beginSession } from '../../src/core/live/session.js'
import { teardownSession } from '../../src/core/live/transport.js'

/** 造一个可手动 resolve/reject 的 deferred。 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 假歌词响应：服务端返回 JSON 字符串里的 LRC 文本。 */
const lrc = (text) => JSON.stringify(`[00:01.00]${text}`)

/** 让当前播放歌曲指向指定 id/platform。 */
function setNowPlaying(id, platform = 'netease') {
  live.nowPlaying = {
    id,
    source: platform,
    title: id,
    artist: 'test',
    duration: 200,
    playableDuration: 200,
    cover: {}
  }
}

test('slow 后 fast：快请求先返回，慢请求不得覆盖（D-13）', async () => {
  beginSession('http://127.0.0.1:18848')
  live.lyrics = []
  const slow = deferred()
  setNowPlaying('slow')
  const slowPromise = fetchLyrics({ id: 'slow', source: 'netease' }, { request: () => slow.promise })

  setNowPlaying('fast')
  const fastPromise = fetchLyrics({ id: 'fast', source: 'netease' }, {
    request: async () => lrc('fast 歌词')
  })
  const fastLines = await fastPromise
  assert.equal(fastLines[0]?.text, 'fast 歌词')
  assert.equal(live.lyrics[0]?.text, 'fast 歌词')

  slow.resolve(lrc('slow 歌词'))
  await slowPromise
  assert.equal(live.lyrics[0]?.text, 'fast 歌词', '旧请求晚返回不得覆盖当前歌曲歌词')
})

test('旧请求失败不得清空当前新歌词', async () => {
  beginSession('http://127.0.0.1:18848')
  const old = deferred()
  setNowPlaying('old')
  const oldPromise = fetchLyrics({ id: 'old', source: 'netease' }, { request: () => old.promise })

  setNowPlaying('new')
  await fetchLyrics({ id: 'new', source: 'netease' }, { request: async () => lrc('新歌词') })
  assert.equal(live.lyrics[0]?.text, '新歌词')

  old.reject(new Error('network boom'))
  await oldPromise
  assert.equal(live.lyrics[0]?.text, '新歌词', '旧请求失败不得清空当前歌词')
})

test('当前歌曲请求失败清空自己歌词（不残留旧歌）', async () => {
  beginSession('http://127.0.0.1:18848')
  setNowPlaying('song-a')
  await fetchLyrics({ id: 'song-a', source: 'netease' }, { request: async () => lrc('A 歌词') })
  assert.equal(live.lyrics[0]?.text, 'A 歌词')
  await fetchLyrics({ id: 'song-a', source: 'netease' }, { request: async () => { throw new Error('500') } })
  assert.deepEqual(live.lyrics, [])
})

test('离开房间使在途歌词请求失效，且不写回已清空的状态', async () => {
  beginSession('http://127.0.0.1:18848')
  setNowPlaying('pending-song')
  const pending = deferred()
  const pendingPromise = fetchLyrics({ id: 'pending-song', source: 'netease' }, { request: () => pending.promise })
  // 模拟内部 teardown（PASSWORD_CHANGED / leaveRoom 同路径）。
  await teardownSession()
  assert.equal(live.nowPlaying, null)
  pending.resolve(lrc('离开后才返回的歌词'))
  await pendingPromise
  assert.deepEqual(live.lyrics, [], '离开房间后在途响应必须丢弃')
})

test('invalidateLyrics 使并发在途请求全部失效', async () => {
  beginSession('http://127.0.0.1:18848')
  setNowPlaying('x')
  const pending = deferred()
  const p = fetchLyrics({ id: 'x', source: 'netease' }, { request: () => pending.promise })
  invalidateLyrics()
  pending.resolve(lrc('不应该出现'))
  await p
  assert.deepEqual(live.lyrics, [])
})

test('歌曲 id 相同但 platform 不同也不得写入（归属校验）', async () => {
  beginSession('http://127.0.0.1:18848')
  setNowPlaying('same-id', 'bilibili')
  const result = await fetchLyrics({ id: 'same-id', source: 'netease' }, { request: async () => lrc('错误平台歌词') })
  assert.deepEqual(result, live.lyrics)
  assert.deepEqual(live.lyrics, [], '平台不匹配不得写入歌词')
})

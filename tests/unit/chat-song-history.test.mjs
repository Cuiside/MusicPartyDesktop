import test from 'node:test'
import assert from 'node:assert/strict'
import { toChatMessage } from '../../src/core/live/mapping.js'

test('old PLAY_START history never points to an unrelated current song', () => {
  const raw = { type: 'PLAY_START', userName: 'Alice', content: '正在播放来自于 Alice 的 测试旧音轨', timestamp: 1000 }
  const row = toChatMessage(raw, { nowPlaying: { id: 'new-id', title: '测试新音轨', artist: 'Fixture' } })
  assert.equal(row.type, 'song')
  assert.equal(row.song.title, '测试旧音轨')
  assert.equal(row.song.id, '')
})

test('current PLAY_START preserves correct playable song metadata', () => {
  const song = { id: 'song-id', title: '测试音轨', artist: 'Fixture' }
  const row = toChatMessage({ type: 'PLAY_START', userName: 'Alice', content: '正在播放来自于 Alice 的 测试音轨' }, { nowPlaying: song })
  assert.equal(row.song.id, 'song-id')
  assert.equal(row.song.artist, 'Fixture')
})

test('SYSTEM history uses source in content, not the sender name', () => {
  const row = toChatMessage({ type: 'PLAY_START', userName: 'SYSTEM', content: '正在播放来自于 历史记录 的 交差点' })
  assert.equal(row.song.title, '交差点')
  assert.equal(row.song.id, '')
  assert.ok(row.song.cover.mark)
})

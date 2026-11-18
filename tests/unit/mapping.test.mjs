/**
 * 协议 v2 / S-01 单元测试：PlayableMusic trial / playableDurationMs / urlType 映射，
 * 以及公开 id（新服务端）与 token（旧服务端）的身份匹配兼容。
 *
 * 运行：node --test tests/unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { toSong, toMember, toChatMessage, publicIdOf } from '../../src/core/live/mapping.js'

test('试听片段：duration 被 playableDurationMs 覆盖，并标记 trial', () => {
  const song = toSong({
    id: 'trial',
    name: '试听曲目',
    platform: 'netease',
    duration: 240000,
    trial: true,
    playableDurationMs: 60000,
    urlType: 'TRIAL',
    url: 'https://example.invalid/trial.wav'
  })
  assert.equal(song.duration, 60, '进度锚定/时长显示必须用实际可播时长')
  assert.equal(song.playableDuration, 60)
  assert.equal(song.fullDuration, 240)
  assert.equal(song.trial, true)
  assert.equal(song.urlType, 'TRIAL')
  assert.match(song.quality, /试听/)
})

test('新服务端保留整曲时长，未知试听长度不伪称已知', () => {
  const preview = toSong({ id: 'x', platform: 'netease', duration: 30000, fullDurationMs: 200000, playableDurationMs: 30000, trial: true })
  assert.equal(preview.duration, 30)
  assert.equal(preview.fullDuration, 200)
  assert.equal(preview.trialDurationKnown, true)
  const unknown = toSong({ id: 'y', platform: 'netease', duration: 200000, fullDurationMs: 200000, playableDurationMs: 0, trial: true })
  assert.equal(unknown.trialDurationKnown, false)
})

test('完整曲目 / 旧服务端（无新字段）保持原时长且不算试听', () => {
  const song = toSong({ id: 'full', name: '完整曲目', platform: 'netease', duration: 200000, urlType: 'FULL' })
  assert.equal(song.duration, 200)
  assert.equal(song.playableDuration, 200)
  assert.equal(song.fullDuration, 200)
  assert.equal(song.trial, false)
  assert.equal(song.urlType, 'FULL')

  const legacy = toSong({ id: 'old', name: '旧服务端', platform: 'netease', duration: 180000 })
  assert.equal(legacy.duration, 180)
  assert.equal(legacy.trial, false)
  assert.equal(legacy.urlType, null)
  assert.doesNotMatch(legacy.quality, /试听/)
})

test('playableDurationMs=0/缺失时回退歌曲时长，字符串 "null" 的 url 被拒绝', () => {
  const zero = toSong({ id: 'z', name: 'z', platform: 'netease', duration: 90000, playableDurationMs: 0 })
  assert.equal(zero.playableDuration, 90)
  const nullUrl = toSong({ id: 'n', name: 'n', platform: 'netease', duration: 1, url: 'null' })
  assert.equal(nullUrl.url, null)
})

test('公开 id（v2 广播）与旧 token 都能匹配“我”', () => {
  assert.equal(publicIdOf({ id: 'pub-1', name: 'n' }), 'pub-1')
  assert.equal(publicIdOf({ token: 'tok-1', name: 'n' }), 'tok-1')
  assert.equal(publicIdOf('raw-id'), 'raw-id')
  assert.equal(publicIdOf(null), '')

  const v2Member = toMember({ id: 'pub-1', name: '我', isGuest: false }, { myId: 'pub-1' })
  assert.equal(v2Member.you, true)
  const legacyMember = toMember({ token: 'tok-9', name: '我', isGuest: false }, { myId: 'tok-9' })
  assert.equal(legacyMember.you, true)
  const other = toMember({ id: 'pub-2', name: '别人', isGuest: true }, { myId: 'pub-1' })
  assert.equal(other.you, false)

  const v2Chat = toChatMessage({ id: 'c1', userId: 'pub-1', userName: '我', content: 'hi' }, { myId: 'pub-1' })
  assert.equal(v2Chat.me, true)
  const otherChat = toChatMessage({ id: 'c2', userId: 'pub-2', userName: '别人', content: 'hi' }, { myId: 'pub-1' })
  assert.equal(otherChat.me, false)
})

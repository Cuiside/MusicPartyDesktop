import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { toQueueItem } from '../../src/core/live/mapping.js'

const app = readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8')
const helper = app.match(/const openFullQueue = \(songId = ''\) => \{[\s\S]*?\n\}/)?.[0]

test('离线成员歌曲保留队列身份，完整队列入口清除隐藏目标的视图状态', () => {
  const item = toQueueItem({ queueId: 'q-offline', music: { id: 'track', name: '离线成员歌曲', platform: 'bilibili' }, enqueuedBy: { id: 'offline-member', name: '离线成员', isGuest: false } })
  assert.equal(item.ownerId, 'offline-member')
  assert.equal(item.queueId, 'q-offline')
  assert.ok(helper)
  const ctx = { showLikedSongs: { value: true }, queueFilter: { value: 'mine' }, queueSource: { value: 'netease' }, selectedId: { value: '' }, active: { value: 'party' } }
  runInNewContext(helper + "; openFullQueue('track')", ctx)
  assert.equal(ctx.showLikedSongs.value, false)
  assert.equal(ctx.queueFilter.value, 'all')
  assert.equal(ctx.queueSource.value, 'all')
  assert.equal(ctx.selectedId.value, item.id)
  assert.equal(ctx.active.value, 'queue')
})

test('接下来歌曲和两个完整队列入口均使用完整队列导航', () => {
  assert.match(app, /id === 'show-all-queue'\) \{ openFullQueue\(\)/)
  assert.match(app, /openFullQueue\(id\.slice\('song:'\.length\)\)/)
  assert.match(app, /@show-queue="openFullQueue\(\)"/)
  assert.match(app, /const list = queueView\.value\.filter/)
  const ctx = { showLikedSongs: { value: true }, queueFilter: { value: 'pinned' }, queueSource: { value: 'bilibili' }, selectedId: { value: 'old' }, active: { value: 'party' } }
  runInNewContext(helper + '; openFullQueue()', ctx)
  assert.equal(ctx.queueFilter.value, 'all')
  assert.equal(ctx.queueSource.value, 'all')
  assert.equal(ctx.showLikedSongs.value, false)
  assert.equal(ctx.selectedId.value, '')
})

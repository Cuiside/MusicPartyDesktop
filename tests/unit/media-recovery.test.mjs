import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaRecovery } from '../../src/core/live/media-recovery.js'

test('media recovery applies only a matching playback and retries at most twice', async () => {
  let state = { session: 1, playbackId: 'one', id: '42', source: 'netease', kind: 'SONG', url: '/media/old' }
  let scheduled, calls = 0, applied = []
  const recovery = createMediaRecovery({ current: () => state, schedule: fn => (scheduled = fn, 1), cancel: () => {},
    refresh: async () => { calls++; return { id: '42', platform: 'netease', url: '/media/new' } }, apply: url => applied.push(url) })
  assert.equal(recovery.request(), true)
  await scheduled()
  assert.deepEqual(applied, ['/media/new'])
  assert.equal(recovery.request(), true)
  state = { ...state, session: 2 }
  await scheduled()
  assert.equal(applied.length, 1)
  assert.equal(recovery.request(), false)
  assert.equal(calls, 2)
  recovery.reset()
  state = { ...state, kind: 'VOICE' }
  assert.equal(recovery.request(), false)
})

test('a pending refresh cannot apply after reset', async () => {
  let scheduled, finish, applied = false
  const state = { session: 1, playbackId: 'one', id: '42', source: 'netease', kind: 'SONG', url: '/media/old' }
  const recovery = createMediaRecovery({ current: () => state, schedule: fn => (scheduled = fn, 1), cancel: () => {},
    refresh: () => new Promise(resolve => { finish = resolve }), apply: () => { applied = true } })
  recovery.request()
  const pending = scheduled()
  recovery.reset()
  finish({ id: '42', platform: 'netease', url: '/media/new' })
  await pending
  assert.equal(applied, false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompactReceiver, mergeState } from '../../src/core/live/compact-sync.js'
import { createRoomClock } from '../../src/core/live/playback-sync.js'

test('compact snapshots recover gaps and preserve sparse state', () => {
  const applied = []
  let requests = 0
  const receiver = createCompactReceiver({ apply: state => applied.push(state), requestSnapshot: () => requests++ })
  const frame = (seq, state, full = false) => ({ v: 1, epoch: 'test', seq, base: full ? seq : seq - 1, full, state })
  receiver.receive(frame(2, { nowPlaying: { currentPosition: 20 } }))
  assert.equal(requests, 1)
  assert.equal(applied.length, 0)
  receiver.receive(frame(1, { queue: [], isPaused: false, nowPlaying: { music: { id: 'a' }, currentPosition: 10 } }, true))
  assert.equal(applied.at(-1).nowPlaying.currentPosition, 20)
  assert.equal(applied.at(-1).nowPlaying.music.id, 'a')
  receiver.receive(frame(1, { queue: [], isPaused: true, nowPlaying: null }, true))
  assert.equal(applied.at(-1).isPaused, false)
  receiver.receive(frame(3, { nowPlaying: null }))
  assert.equal(applied.at(-1).nowPlaying, null)
  receiver.reset()
  assert.equal(receiver.isActive(), false)
  mergeState({}, JSON.parse('{"__proto__":{"polluted":true}}'))
  assert.equal({}.polluted, undefined)
})

test('room clock keeps progress across delayed samples and honors explicit seek', () => {
  let now = 0
  const clock = createRoomClock(() => now)
  const state = { queue: [], isPaused: false, playbackId: 'one', seekNonce: 0,
    nowPlaying: { music: { platform: 'netease', id: 'a', url: 'https://example.test/a', duration: 120000 }, currentPosition: 10000 } }
  clock.sample(state)
  now = 5000
  clock.sample({ ...state, nowPlaying: { ...state.nowPlaying, currentPosition: 11000 } })
  assert.equal(clock.position(), 15000)
  clock.sample({ ...state, seekNonce: 1, nowPlaying: { ...state.nowPlaying, currentPosition: 3000 } })
  assert.equal(clock.position(), 3000)
})

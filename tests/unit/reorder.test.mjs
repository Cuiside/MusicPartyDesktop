import test from 'node:test'
import assert from 'node:assert/strict'
import { planReorder } from '../../src/core/live/reorder.js'

const item = (id, owner, priority = 'REGULAR') => ({ queueId: id, ownerId: owner, priority, source: 'netease' })
test('sequential reorder moves normal items and leaves pins in place', () => {
  const a = item('a', 'alice'), pin = item('p', 'alice', 'GLOBAL_TOP'), b = item('b', 'bob')
  assert.deepEqual(planReorder([a, pin, b], [b, a, pin], b, 'alice', 'SEQUENTIAL'),
    { queueId: 'b', beforeQueueId: 'a', playMode: 'SEQUENTIAL' })
  assert.equal(planReorder([a, pin, b], [pin, a, b], pin, 'alice', 'SEQUENTIAL'), null)
})
test('other modes reorder only the current member and reject stale or no-op drags', () => {
  const a = item('a', 'alice'), b = item('b', 'bob'), c = item('c', 'alice')
  assert.deepEqual(planReorder([a, b, c], [c, a, b], c, 'alice', 'ROUND_ROBIN'),
    { queueId: 'c', beforeQueueId: 'a', playMode: 'ROUND_ROBIN' })
  assert.equal(planReorder([a, b, c], [b, a, c], b, 'alice', 'ROUND_ROBIN'), null)
  assert.equal(planReorder([a, b, c], [a, b], a, 'alice', 'SEQUENTIAL'), null)
  assert.equal(planReorder([a, b, c], [a, b, c], a, 'alice', 'SEQUENTIAL'), null)
})

const modes = new Set(['SEQUENTIAL', 'SHUFFLE', 'ROUND_ROBIN', 'REPEAT_ONE'])
const member = value => typeof value === 'string' && value.trim() && value !== 'SYSTEM' && value !== 'ADMIN' && !value.startsWith('__')

/** Translate a drag to the server's reorderable subset; pinned/other-member slots stay fixed. */
export function planReorder(queue, next, moved, actor, mode) {
  if (!modes.has(mode) || !member(actor) || !Array.isArray(queue) || !Array.isArray(next)) return null
  const canMove = item => item?.queueId && member(item.ownerId) && item.priority === 'REGULAR' &&
    item.source !== 'netease-fm' && (mode === 'SEQUENTIAL' || item.ownerId === actor)
  if (!canMove(moved) || queue.length !== next.length) return null
  const original = queue.filter(canMove).map(item => item.queueId)
  const desired = next.filter(canMove).map(item => item.queueId)
  if (new Set(original).size !== original.length || original.length !== desired.length ||
      original.some(id => !desired.includes(id)) || original.join('\0') === desired.join('\0')) return null
  const position = desired.indexOf(moved.queueId)
  if (position < 0) return null
  const beforeQueueId = desired[position + 1] || null
  const expected = original.filter(id => id !== moved.queueId)
  expected.splice(beforeQueueId == null ? expected.length : expected.indexOf(beforeQueueId), 0, moved.queueId)
  if (expected.join('\0') !== desired.join('\0')) return null
  return { queueId: moved.queueId, beforeQueueId, playMode: mode }
}

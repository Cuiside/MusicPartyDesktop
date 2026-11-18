import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_BINDINGS_KEY, readLocalBindings, saveLocalBinding } from '../../src/core/live/local-bindings.js'

function storage() {
  const data = new Map()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}

test('bindings survive reload locally, are independent for each platform and profile', () => {
  const first = storage(), second = storage()
  saveLocalBinding('netease', { id: '100', name: 'Alice', cookie: 'must-not-save' }, first)
  saveLocalBinding('bilibili', { id: '200', name: 'Bob' }, first)
  assert.deepEqual(readLocalBindings(first), { netease: { id: '100', name: 'Alice' }, bilibili: { id: '200', name: 'Bob' } })
  assert.deepEqual(readLocalBindings(second), {})
  assert.equal(first.getItem(LOCAL_BINDINGS_KEY).includes('must-not-save'), false)
  saveLocalBinding('netease', null, first)
  assert.deepEqual(readLocalBindings(first), { bilibili: { id: '200', name: 'Bob' } })
})

test('malformed storage is safe and unsupported platforms cannot be bound', () => {
  const data = storage()
  data.setItem(LOCAL_BINDINGS_KEY, '{bad json')
  assert.doesNotThrow(() => readLocalBindings(data))
  assert.throws(() => saveLocalBinding('unexpected', { id: 'x' }, data))
  assert.throws(() => saveLocalBinding('netease', { id: '' }, data))
})

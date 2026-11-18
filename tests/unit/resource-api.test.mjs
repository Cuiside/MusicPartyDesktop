import test from 'node:test'
import assert from 'node:assert/strict'
import { beginSession, endSession } from '../../src/core/live/session.js'
import { clearRoomAccess, getPlaylistSongs, getUserPlaylists, searchPlatform, usesResourceApi, verifyRoomAccess } from '../../src/core/live/api.js'

const json = (status, data) => ({ status, bodyText: JSON.stringify(data), contentType: 'application/json' })

test('current resource API sends password only to the active room and follows opaque cursors', async () => {
  const calls = []
  globalThis.window = { mpDesktop: { http: { request: async req => {
    calls.push(req)
    const path = new URL(req.url).pathname
    if (path === '/api/auth/status') return json(200, { hasProtection: true })
    if (path === '/api/auth/verify') return json(200, { valid: true })
    if (path === '/api/v2/sources') return json(200, { schemaVersion: 2, sources: [] })
    if (path.endsWith('/tracks/search')) return json(200, { items: [{ id: 's1', name: 'Song', platform: 'netease' }] })
    if (path.endsWith('/collection-categories')) return json(200, [{ id: 'playlists', entryKind: 'CONTAINER', collectionType: 'playlist' }])
    if (path.endsWith('/collections/playlists')) return json(200, { items: [{ id: 'p1', name: 'List', collectionType: 'playlist' }], nextCursor: null })
    if (path.endsWith('/containers/playlist/p1/tracks')) return json(200, { items: [], nextCursor: 'opaque-next' })
    throw new Error(`Unexpected route ${path}`)
  } } } }
  try {
    beginSession('https://room-a.example')
    assert.equal((await verifyRoomAccess('fixture-room-password')).ok, true)
    assert.equal(await usesResourceApi(), true)
    assert.equal((await searchPlatform('netease', 'test'))[0].id, 's1')
    assert.equal((await getUserPlaylists('netease', 'user'))[0].collectionType, 'playlist')
    assert.equal((await getPlaylistSongs('netease', 'p1')).nextCursor, 'opaque-next')
    assert.ok(calls.filter(call => call.url.includes('/api/v2/')).every(call => call.headers['X-Room-Password'] === 'fixture-room-password'))
    endSession()
    beginSession('https://room-b.example')
    await usesResourceApi()
    assert.equal(calls.at(-1).headers['X-Room-Password'], undefined)
  } finally { clearRoomAccess(); endSession(); delete globalThis.window }
})

test('legacy fallback is allowed for an absent API but never for forbidden access', async () => {
  let forbidden = false
  globalThis.window = { mpDesktop: { http: { request: async req => {
    const path = new URL(req.url).pathname
    if (path === '/api/v2/sources') return json(forbidden ? 403 : 404, { message: 'denied' })
    if (path.startsWith('/api/search/')) return json(200, [{ id: 'legacy', name: 'Old', platform: 'netease' }])
    throw new Error(`Unexpected route ${path}`)
  } } } }
  try {
    beginSession('https://old.example')
    assert.equal((await searchPlatform('netease', 'test'))[0].id, 'legacy')
    endSession(); forbidden = true
    beginSession('https://forbidden.example')
    await assert.rejects(() => usesResourceApi(), /denied/)
  } finally { clearRoomAccess(); endSession(); delete globalThis.window }
})

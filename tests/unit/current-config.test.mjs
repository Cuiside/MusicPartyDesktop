import test from 'node:test'
import assert from 'node:assert/strict'
import { toConfig } from '../../src/core/live/mapping.js'

test('current source configuration and room features are preserved alongside legacy format', () => {
  const current = toConfig({ sources: { netease: { enabled: false }, bilibili: { enabled: true } },
    allowSeek: true, allowPlaylistClaim: true, retainPlaylist: true })
  assert.equal(current.neteaseEnabled, false)
  assert.equal(current.bilibiliEnabled, true)
  assert.equal(current.allowSeek, true)
  assert.equal(current.allowPlaylistClaim, true)
  assert.equal(current.retainPlaylist, true)
  assert.equal(toConfig({ neteaseEnabled: false }).neteaseEnabled, false)
})

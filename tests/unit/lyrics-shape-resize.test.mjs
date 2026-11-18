import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

// Exercise the actual main-process region functions with a window that does
// not emit resize events for setBounds, as observed on some Windows versions.
const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
const shape = source.match(/function setLyricsShape\(windowRef, glass\) \{[\s\S]*?\n\}/)?.[0]
const bounds = source.match(/function setLyricsBounds\(windowRef, bounds\) \{[\s\S]*?\n\}/)?.[0]

test('programmatic enlarge, shrink and reset refresh the native window region', () => {
  assert.ok(shape); assert.ok(bounds)
  const context = { lyricsState: { glass: false }, console, Math }
  vm.runInNewContext(`${shape}\n${bounds}\nthis.update = setLyricsBounds`, context)
  let size = [760, 180], regions = []
  const win = {
    isDestroyed: () => false,
    setBounds: value => { size = [value.width, value.height] },
    getContentSize: () => size,
    setShape: value => { regions = value }
  }
  for (const [width, height] of [[1200, 284], [320, 76], [760, 180]]) {
    context.update(win, { x: 0, y: 0, width, height })
    assert.ok(regions.some(r => r.x + r.width === width && r.y + r.height === height))
  }
  context.lyricsState.glass = true
  context.update(win, { x: 0, y: 0, width: 1200, height: 284 })
  assert.ok(regions.some(r => r.x === 0 && r.width === 1200))
  assert.ok(regions.some(r => r.y + r.height === 284))
})

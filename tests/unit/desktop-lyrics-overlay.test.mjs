import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function overlay() {
  const elements = {}
  function element() { return { style: { setProperty(key,value) { this[key]=value } }, classList: { toggle() {} }, children: [], clientHeight: 180, scrollHeight: 100, textContent: '', appendChild(x) { this.children.push(x) }, replaceChildren() { this.children = [] }, addEventListener() {} } }
  for (const id of ['text','trans','content','overlay','close']) elements[id] = element()
  let callback, frame, now = 0
  const context = { Intl, Math, Number, performance: { now: () => now }, document: { getElementById: id => elements[id], querySelector: selector => elements[selector.slice(1)], createElement: element }, window: { desktopLyrics: { onState: cb => { callback = cb }, close() {} }, addEventListener() {} }, requestAnimationFrame: cb => { frame = cb } }
  vm.runInNewContext(readFileSync(new URL('../../electron/lyrics.js', import.meta.url), 'utf8'), context)
  return { elements, send(state) { callback(state) }, tick(ms) { now = ms; frame(ms) } }
}
test('overlay segments long Unicode text and applies color, font, and translation', () => {
  const o = overlay(); const text = '长'.repeat(500) + '👨‍👩‍👧‍👦e\u0301'
  o.send({ text, trans: '翻译', color: '#12ab34', font: 'serif', start: 0, end: 10, time: 0 })
  assert.equal(o.elements.text.children.length, 502); assert.equal(o.elements.text.children.map(x => x.textContent).join(''), text)
  assert.equal(o.elements.content.style.color, '#12ab34'); assert.match(o.elements.content.style.fontFamily, /SimSun/); assert.equal(o.elements.trans.textContent, '翻译')
})
test('fill and wave track estimated line progress, pause and seek', () => {
  const o = overlay(); const state = { text: 'abcd', color: '#123456', start: 10, end: 14, time: 11.5, playing: true, fill: true, wave: true }
  o.send(state); o.tick(0)
  assert.match(o.elements.text.children[0].style.backgroundImage, /100%/); assert.match(o.elements.text.children[1].style.transform, /translateY/)
  o.send({ ...state, playing: false }); o.tick(500); assert.equal(o.elements.text.children[1].style.transform, '')
  o.send({ ...state, time: 13, playing: false }); o.tick(500); assert.match(o.elements.text.children[2].style.backgroundImage, /100%/); assert.match(o.elements.text.children[3].style.backgroundImage, /0%/)
  o.send({ ...state, time: 10, playing: false, fill: false, wave: false }); o.tick(500); assert.equal(o.elements.text.children[0].style.backgroundImage, '')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createRenderer, nextTick } from 'vue'

test('InstantChat playback and system filters are independent', async () => {
  const source = await readFile(new URL('../../src/components/InstantChat.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const compiled = compileScript(descriptor, { id: 'instant-chat-test', inlineTemplate: true }).content
    .replaceAll("from 'vue'", "from '" + import.meta.resolve('vue') + "'")
    .replaceAll('from "vue"', "from '" + import.meta.resolve('vue') + "'")
    .replace("from 'lucide-vue-next'", "from '" + import.meta.resolve('lucide-vue-next') + "'")
    .replace("import TrackCover from './TrackCover.vue'", 'const TrackCover = {}')
  const { default: InstantChat } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
    const node = (type, text = '') => ({ type, text, children: [], props: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn }, removeEventListener(name) { delete this.listeners[name] } })
    const renderer = createRenderer({
      createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
      setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] },
      parentNode: el => el.parent, nextSibling: el => { const siblings = el.parent?.children || []; return siblings[siblings.indexOf(el) + 1] || null },
      insert: (el, parent, anchor) => { if (el.parent) { const i = el.parent.children.indexOf(el); if (i >= 0) el.parent.children.splice(i, 1) } el.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, el) },
      remove: el => { const i = el.parent?.children.indexOf(el) ?? -1; if (i >= 0) el.parent.children.splice(i, 1) },
      patchProp: (el, key, prev, value) => { el.props[key] = value; el[key] = value }
    })
    const events = []
    const song = { id: 'song-id', title: 'Track', artist: 'Artist' }
    const root = node('root')
    renderer.createApp(InstantChat, { messages: [
      { id: 'c', type: 'chat', text: 'Chat message' },
      { id: 's', type: 'song', song },
      { id: 'l', type: 'system', text: 'System log' }
    ], sendMessage: async () => true, onAdd: value => events.push(value) }).mount(root)
    const all = el => [el, ...el.children.flatMap(all)]
    const content = () => all(root).map(el => el.text).join(' ')
    const checks = all(root).filter(el => el.props.type === 'checkbox')
    assert.equal(checks.length, 2)
    assert.equal(checks[0].checked, false)
    assert.equal(checks[1].checked, false)
    const verify = (chat, track, log) => { assert.equal(content().includes('Chat message'), chat); assert.equal(content().includes('Track'), track); assert.equal(content().includes('System log'), log) }
    const toggle = async (box, checked) => { box.checked = checked; box.listeners.change({ target: box }); await nextTick() }
    verify(true, false, false)
    await toggle(checks[0], true); verify(true, false, true)
    await toggle(checks[1], true); verify(true, true, true)
    all(root).find(el => el.type === 'button' && el.text === '点歌').props.onClick()
    assert.deepEqual(events, [song])
    await toggle(checks[0], false); verify(true, true, false)
    await toggle(checks[1], false); verify(true, false, false)
})



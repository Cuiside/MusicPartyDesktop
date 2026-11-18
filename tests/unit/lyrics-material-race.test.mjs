import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

test('stale native glass failure cannot re-enable glass after user switches it off', () => {
  const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
  const start = source.indexOf('let lyricsMaterialBusy = false')
  const end = source.indexOf('const LYRICS_RATIO', start)
  assert.ok(start > 0 && end > start)
  const children = [], materials = []
  let recreated = 0, destroyed = false
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n)
  const overlay = { isDestroyed:()=>destroyed, getNativeWindowHandle:()=>handle, setBackgroundMaterial:x=>materials.push(x), getBounds:()=>({x:1,y:1,width:760,height:180}), destroy:()=>{ destroyed=true } }
  const ctx = { process:{platform:'win32',pid:123}, lyricsWindow:null, lyricsBackdropWindow:overlay, lyricsState:{glass:true,glassOpacity:50}, lyricsBounds:null, app:{isPackaged:false}, __dirname:'/', path:{join:(...xs)=>xs.join('/')}, fs:{existsSync:()=>true}, console, win:{isDestroyed:()=>false,webContents:{send(){}}}, openLyricsWindow:()=>{recreated++}, setTimeout:()=>1, clearTimeout:()=>{}, spawn:()=>{const child=new EventEmitter();child.kill=()=>{};children.push(child);return child} }
  vm.runInNewContext(source.slice(start,end) + '\nthis.enqueue=queueNativeLyricsMaterial',ctx)
  ctx.enqueue(overlay,0)
  ctx.lyricsState.glass=false
  ctx.enqueue(overlay,-1)
  children[0].emit('exit',1)
  assert.deepEqual(materials,[])
  assert.equal(children.length,2)
  children[1].emit('exit',1)
  assert.equal(destroyed,true)
  assert.equal(recreated,0)
})

test('maximum glass transparency clears native blur instead of retaining acrylic', () => {
  const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
  const fn = source.match(/function applyLyricsMaterial\(windowRef, glass\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(fn)
  const commands = []
  const windowRef = { _lyricsNativeTouched:true, isDestroyed:()=>false, setBackgroundMaterial(){}, setBackgroundColor(){} }
  const context = { lyricsState:{glassOpacity:100}, lyricsBackdropWindow:windowRef, lyricsWindow:null, queueNativeLyricsMaterial:(_window,value)=>commands.push(value), setLyricsShape(){} }
  vm.runInNewContext(fn + '\nthis.apply=applyLyricsMaterial',context)
  context.apply(windowRef,true)
  assert.deepEqual(commands,[-1])
  commands.length=0; windowRef._lyricsNativeTouched=false
  context.apply(windowRef,true)
  assert.deepEqual(commands,[])
  context.lyricsState.glassOpacity=0
  context.apply(windowRef,true)
  assert.deepEqual(commands,[0])
})

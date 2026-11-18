import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('spectrum interpolates 64 bars per animation frame and stops drawing when disabled', () => {
  const draws=[]
  const element = () => ({ style:{setProperty(k,v){this[k]=v}}, classList:{toggle(){}}, children:[], textContent:'', addEventListener(){}, setAttribute(){}, replaceChildren(){this.children=[]}, appendChild(x){this.children.push(x)} })
  const elements={text:element(),trans:element(),content:element(),overlay:element(),close:element()}
  const ctx={clearRect(){},fillRect(x,y,w,h){draws.push({x,y,w,h})}}
  elements.spectrum={...element(),hidden:true,width:0,height:0,getBoundingClientRect:()=>({width:640,height:72}),getContext:()=>ctx}
  let stateListener,spectrumListener,frame,now=0
  const context={Intl,Math,Number,performance:{now:()=>now},document:{getElementById:id=>elements[id],querySelector:s=>elements[s.slice(1)],createElement:element},window:{devicePixelRatio:1,desktopLyrics:{onState:cb=>{stateListener=cb},onSpectrum:cb=>{spectrumListener=cb},close(){}},addEventListener(){}},requestAnimationFrame:cb=>{frame=cb}}
  vm.runInNewContext(readFileSync(new URL('../../electron/lyrics.js',import.meta.url),'utf8'),context)
  stateListener({text:'歌词',spectrum:true})
  spectrumListener(Array(64).fill(128))
  now=16;frame(now);assert.equal(draws.length,64);const first=draws[0].h
  draws.length=0;now=32;frame(now);assert.equal(draws.length,64);assert.ok(draws[0].h>first)
  stateListener({text:'歌词',spectrum:false})
  draws.length=0;now=48;frame(now);assert.equal(draws.length,0)
})

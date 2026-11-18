import { reactive } from 'vue'
export const lyricColors = [{label:'白',value:'#ffffff'},{label:'黄',value:'#ffcd38'},{label:'粉',value:'#ec9fb9'},{label:'红',value:'#ec8581'},{label:'紫',value:'#a78bfa'},{label:'青',value:'#67e8f9'}]
export const lyricFonts = [{id:'default',label:'默认'},{id:'sans',label:'黑体'},{id:'serif',label:'宋体'},{id:'rounded',label:'圆体'}]
let saved = {}
try { saved = JSON.parse(localStorage.getItem('mp.desktop.lyrics.style') || '{}') || {} } catch {}
export const lyricStyle = reactive({ color:/^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color.toLowerCase() : '#ffffff', font:lyricFonts.some(x=>x.id===saved.font) ? saved.font : 'default', fill: saved.fill === true, wave: saved.wave === true })
Object.assign(lyricStyle, { border: saved.border === true, borderWidth: Number.isFinite(saved.borderWidth) ? Math.max(1, Math.min(10, saved.borderWidth)) : 2, borderOpacity: Number.isFinite(saved.borderOpacity) ? Math.max(0, Math.min(100, saved.borderOpacity)) : 70, glass: saved.glass === true, fontSize: Number.isFinite(saved.fontSize) ? Math.max(12, Math.min(80, saved.fontSize)) : 26 })
Object.assign(lyricStyle, { spectrum: saved.spectrum === true, glassOpacity: Number.isFinite(saved.glassOpacity) ? Math.max(0,Math.min(100,saved.glassOpacity)) : 70 })
export function setLyricStyle(patch) {
  if (/^#[0-9a-f]{6}$/i.test(patch.color)) lyricStyle.color=patch.color.toLowerCase()
  if (lyricFonts.some(x=>x.id===patch.font)) lyricStyle.font=patch.font
  if (typeof patch.fill === 'boolean') lyricStyle.fill=patch.fill
  if (typeof patch.wave === 'boolean') lyricStyle.wave=patch.wave
  for (const key of ['border','glass','spectrum']) if (typeof patch[key] === 'boolean') lyricStyle[key] = patch[key]
  for (const [key, min, max] of [['borderWidth',1,10], ['borderOpacity',0,100], ['fontSize',12,80], ['glassOpacity',0,100]]) if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) lyricStyle[key] = Math.max(min, Math.min(max, patch[key]))
  try { localStorage.setItem('mp.desktop.lyrics.style', JSON.stringify(lyricStyle)); return true } catch { return false }
}
export function resetLyricStyle() { return setLyricStyle({ color:'#ffffff', font:'default', fill:false, wave:false, border:false, borderWidth:2, borderOpacity:70, glass:false, fontSize:26, spectrum:false, glassOpacity:70 }) }

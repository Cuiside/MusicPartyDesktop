'use strict'
const text = document.getElementById('text')
const trans = document.getElementById('trans')
const content = document.getElementById('content')
const overlay = document.querySelector('.overlay')
const resizeHandle = document.querySelector('.resize-handle')
const spectrumCanvas = document.getElementById('spectrum')
const muteButton = document.getElementById('mute')
const likeButton = document.getElementById('like')
const likeBubble = document.getElementById('like-bubble')
const fonts = { default: "'Microsoft YaHei UI',sans-serif", sans: "'Microsoft YaHei',sans-serif", serif: 'SimSun,serif', rounded: "YouYuan,'Microsoft YaHei UI',sans-serif" }
let state = {}, received = performance.now(), currentText = '', chars = []
let spectrumTargets = [], spectrumLevels = [], spectrumLastFrame = 0
function fitLyrics() {
  content.style.transform = ''
  content.style.fontSize = ''
}
function setText(value) {
  if (value === currentText) return
  currentText = value
  text.replaceChildren()
  // Grapheme segmentation keeps emoji and combined characters intact.
  const parts = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)].map(x=>x.segment) : Array.from(value)
  chars = parts.map(part => { const span = document.createElement('span'); span.textContent = part; text.appendChild(span); return span })
}
window.desktopLyrics.onState((next) => {
  state = next || {}
  received = performance.now()
  setText(state.text || '暂无歌词')
  trans.textContent = state.trans || ''
  content.style.color = /^#[0-9a-f]{6}$/i.test(state.color || '') ? state.color : '#ffffff'
  content.style.fontFamily = fonts[state.font] || fonts.default
  const rgb = hexToRgb(state.color)
  overlay.style.setProperty('--border-rgb', rgb.join(','))
  overlay.style.setProperty('--border-alpha', String(Math.max(0, Math.min(100, Number(state.borderOpacity ?? 70))) / 100))
  overlay.style.setProperty('--border-width', `${Math.max(1, Math.min(10, Number(state.borderWidth) || 2))}px`)
  overlay.style.setProperty('--font-size', `${Math.max(12, Math.min(80, Number(state.fontSize) || 26))}px`)
  const glassTransparency = Math.max(0, Math.min(100, Number(state.glassOpacity ?? 70)))
  overlay.style.setProperty('--glass-a', '0')
  overlay.style.setProperty('--glass-b', '0')
  overlay.style.setProperty('--glass-blur', '0px')
  overlay.classList.toggle('has-border', state.border === true)
  overlay.classList.toggle('glass', state.glass === true)
  // Native acrylic is rendered by the dedicated backdrop window. Keep this
  // interactive window transparent so controls and lyrics never get tinted.
  overlay.style.background = 'transparent'
  overlay.style.backdropFilter = 'none'
  overlay.classList.toggle('has-spectrum', state.spectrum === true)
  if (spectrumCanvas) spectrumCanvas.hidden = state.spectrum !== true
  if (muteButton) { muteButton.setAttribute('aria-label', state.muted ? '取消本机静音' : '本机静音'); muteButton.title = state.muted ? '取消本机静音' : '本机静音'; muteButton.style.opacity = state.muted ? '.55' : '1' }
  if (likeButton) { likeButton.classList.toggle('liked', state.liked === true); likeButton.setAttribute('aria-pressed', String(state.liked === true)) }
  fitLyrics()
})
function hexToRgb(value) { const match = /^#([0-9a-f]{6})$/i.exec(value || ''); return match ? [parseInt(match[1].slice(0,2),16), parseInt(match[1].slice(2,4),16), parseInt(match[1].slice(4),16)] : [255,255,255] }
function animate(now) {
  const length = state.end - state.start
  const position = Number(state.time || 0) + (state.playing ? Math.min(1, Math.max(0,(now-received)/1000)) : 0)
  const progress = length > 0 ? Math.max(0, Math.min(1, (position-state.start)/length)) : 0
  const color = /^#[0-9a-f]{6}$/i.test(state.color || '') ? state.color : '#ffffff'
  chars.forEach((span,i) => {
    const relative = progress * chars.length - i
    const fraction = Math.max(0,Math.min(1,relative))
    if (state.fill) {
      span.style.backgroundImage = 'linear-gradient(to right,'+color+' '+(fraction*100)+'%,#a8a8a8 '+(fraction*100)+'%)'
      span.style.backgroundClip = 'text'; span.style.webkitBackgroundClip = 'text'; span.style.color = 'transparent'
    } else { span.style.backgroundImage = ''; span.style.backgroundClip = ''; span.style.webkitBackgroundClip = ''; span.style.color = '' }
    const rise = state.wave && state.playing && relative > 0 && relative < 1 ? Math.sin(Math.PI*relative)*5 : 0
    span.style.transform = rise ? 'translateY(-'+rise+'px)' : ''
  })
  drawSpectrum(now)
  requestAnimationFrame(animate)
}
requestAnimationFrame(animate)
window.addEventListener('resize', fitLyrics)
document.querySelector('.close').addEventListener('click', () => window.desktopLyrics.close())
muteButton?.addEventListener('click', () => window.desktopLyrics.command('local-mute'))
likeButton?.addEventListener('click', () => window.desktopLyrics.command('like'))
let bubbleTimer = 0
window.desktopLyrics.onLike?.(data => {
  if (!likeBubble) return
  clearTimeout(bubbleTimer)
  const message = String(data?.message || '')
  likeBubble.textContent = message ? '♥ ' + message : ''
  likeBubble.hidden = !message
  if (message) bubbleTimer = setTimeout(() => { likeBubble.hidden = true }, 3200)
})
window.desktopLyrics.onSpectrum?.(bins => {
  if (!spectrumCanvas || spectrumCanvas.hidden || !Array.isArray(bins)) return
  spectrumTargets = bins.slice(0,64).map(value => Math.max(0, Math.min(255, Number(value) || 0)) / 255)
})
function drawSpectrum(now) {
  if (!spectrumCanvas || spectrumCanvas.hidden || !spectrumTargets.length) { spectrumLastFrame = 0; return }
  // Some Electron/Windows configurations deliver rAF well above the display
  // refresh rate; cap spectrum painting to ~60 FPS to avoid unnecessary work.
  if (spectrumLastFrame && now - spectrumLastFrame < 16) return
  const rect = spectrumCanvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rect.width*dpr)), height = Math.max(1, Math.round(rect.height*dpr))
  if (spectrumCanvas.width !== width || spectrumCanvas.height !== height) { spectrumCanvas.width = width; spectrumCanvas.height = height }
  const ctx = spectrumCanvas.getContext('2d'); if (!ctx) return
  ctx.clearRect(0,0,width,height)
  const elapsed = spectrumLastFrame ? Math.min(100, Math.max(0, now - spectrumLastFrame)) : 16
  spectrumLastFrame = now
  const easing = 1 - Math.exp(-elapsed / 65)
  const gap = Math.max(1, 2*dpr), step = width / spectrumTargets.length, bar = Math.max(1, step-gap)
  if (spectrumLevels.length !== spectrumTargets.length) spectrumLevels = spectrumTargets.map(() => 0)
  spectrumTargets.forEach((target,i) => {
    const boosted = Math.min(1, Math.pow(target, .72) * 1.3)
    spectrumLevels[i] += (boosted - spectrumLevels[i]) * easing
    ctx.fillStyle = i % 9 === 0 ? 'rgba(20,19,20,.45)' : 'rgba(20,19,20,.82)'
    const h = Math.max(2*dpr, Math.min(height, spectrumLevels[i]*height))
    ctx.fillRect(Math.round(i*step),height-h,bar,h)
  })
}
if (resizeHandle) {
  resizeHandle.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); resizeHandle.setPointerCapture?.(event.pointerId); window.desktopLyrics.resizeStart(event.screenX, event.screenY) })
  resizeHandle.addEventListener('pointermove', event => { if (resizeHandle.hasPointerCapture?.(event.pointerId)) window.desktopLyrics.resize(event.screenX, event.screenY) })
  resizeHandle.addEventListener('pointerup', event => { window.desktopLyrics.resizeEnd(); if (resizeHandle.hasPointerCapture?.(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId) })
  resizeHandle.addEventListener('pointercancel', event => { window.desktopLyrics.resizeEnd(); if (resizeHandle.hasPointerCapture?.(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId) })
}

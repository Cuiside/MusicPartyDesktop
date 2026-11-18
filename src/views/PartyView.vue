<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Heart,
  Captions,
  ChevronUp,
  ChevronDown,
  Pause,
  Play,
  Repeat2,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-vue-next'
import TrackCover from '../components/TrackCover.vue'
import Visualizer from '../components/Visualizer.vue'
import LyricsPanel from '../components/LyricsPanel.vue'
import { engine } from '../core/audio/engine'
import { LONG_PRESS_MS, playback, tickPlayback } from '../core/playback'
import { lyricStyle, lyricColors, lyricFonts, setLyricStyle, resetLyricStyle } from '../core/desktop-lyrics-style.js'
const lyricMenuOpen = ref(false)
const lyricMenuAnchor = ref(null)
const lyricMenuPanel = ref(null)
const lyricMenuPosition = ref({})
const placeLyricMenu = () => {
  if (!lyricMenuOpen.value || !lyricMenuAnchor.value) return
  const r = lyricMenuAnchor.value.getBoundingClientRect(), margin = 8
  if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) { lyricMenuOpen.value = false; return }
  const width = Math.max(0, Math.min(320, window.innerWidth - margin * 2))
  const above = Math.max(0, r.top - margin * 2), below = Math.max(0, window.innerHeight - r.bottom - margin * 2)
  const useAbove = above >= below
  const height = Math.max(0, Math.min(400, useAbove ? above : below))
  lyricMenuPosition.value = { left: `${Math.max(margin, Math.min(r.right - width, window.innerWidth - width - margin))}px`, width: `${width}px`, maxHeight: `${height}px`, ...(useAbove ? { bottom: `${window.innerHeight-r.top+margin}px`, top:'auto' } : { top: `${r.bottom+margin}px`, bottom:'auto' }) }
}
const toggleLyricMenu = async () => { lyricMenuOpen.value = !lyricMenuOpen.value; if (lyricMenuOpen.value) { await nextTick(); placeLyricMenu() } }
const dismissLyricMenu = event => { if (lyricMenuOpen.value && !lyricMenuAnchor.value?.contains(event.target) && !lyricMenuPanel.value?.contains(event.target)) lyricMenuOpen.value = false }
const closeLyricMenuOnEscape = event => { if (event.key === 'Escape' && lyricMenuOpen.value) { event.stopPropagation(); lyricMenuOpen.value = false; lyricMenuAnchor.value?.focus() } }
const lyricMessage = ref('')
const resetLyrics = () => { if (!resetLyricStyle()) lyricMessage.value = '设置保存失败，请检查本地存储'; window.mpDesktop?.lyrics?.resetBounds?.() }
const updateLyricStyle = patch => { lyricMessage.value = setLyricStyle(patch) ? '' : '设置保存失败，请检查本地存储' }
const rgbValue = i => parseInt(lyricStyle.color.slice(1 + i * 2, 3 + i * 2), 16)
const setRgb = (i, event) => {
  const values = [0, 1, 2].map(rgbValue)
  values[i] = Math.max(0, Math.min(255, Math.round(Number(event.target.value) || 0)))
  updateLyricStyle({ color: '#' + values.map(n => n.toString(16).padStart(2, '0')).join('') })
}

const props = defineProps({
  nowPlaying: { type: Object, default: null },
  queue: { type: Array, required: true },
  lyrics: { type: Array, required: true },
  live: { type: Boolean, default: false },
  playMode: { type: String, default: '' },
  playbackId: { type: String, default: '' },
  canSeek: { type: Boolean, default: false },
  modeLocked: { type: Boolean, default: false },
  desktopLyricsOpen: { type: Boolean, default: false },
  desktopLyricsAvailable: { type: Boolean, default: false },
  /** 首次「本机静音」说明气泡是否展示（由 App 控制一次性 localStorage 标记）。 */
  pauseHint: { type: Boolean, default: false }
})
const emit = defineEmits([
  'refresh-list',
  'skip',
  'search',
  'volume',
  'local-mute',
  'global-toggle',
  'like',
  'show-queue',
  'dismiss-pause-hint',
  'play-mode',
  'seek-room',
  'toggle-desktop-lyrics'
])

let seekPlaybackId = ''
const rememberSeekPlayback = () => { seekPlaybackId = props.playbackId }
const commitSeek = event => {
  emit('seek-room', { seconds: Number(event.target.value), playbackId: seekPlaybackId })
  seekPlaybackId = ''
}
const changeMode = event => {
  emit('play-mode', event.target.value)
  event.target.value = props.playMode
}

const onVolumeClick = (event) => {
  const rect = event.currentTarget.getBoundingClientRect()
  const pct = Math.round(((event.clientX - rect.left) / rect.width) * 100)
  emit('volume', Math.max(0, Math.min(100, pct)))
}

const pct = computed(() =>
  Math.min(100, (playback.progress / (props.nowPlaying?.duration || 1)) * 100)
)

const fmt = (seconds) => {
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ */
/* 播放键：单击 = 本机静音；长按 ≥500ms = 全局暂停/恢复（App 负责权限+服务端命令） */
/* ------------------------------------------------------------------ */
const pressActive = ref(false)
const holdAnimating = ref(false)
const pendingToggle = ref(false)
const pressStartedPlaying = ref(false)
const longPressFired = ref(false)
let suppressPartialClick = false
let pressTimer = 0
let animationTimer = 0
let pendingTimer = 0
const dotAtRight = computed(() => (holdAnimating.value || pendingToggle.value) ? !pressStartedPlaying.value : playback.playing)
watch(() => playback.playing, () => { if (pendingToggle.value) { pendingToggle.value = false; window.clearTimeout(pendingTimer) } })

const clearPressTimer = () => {
  if (pressTimer) {
    window.clearTimeout(pressTimer)
    pressTimer = 0
  }
  if (animationTimer) { window.clearTimeout(animationTimer); animationTimer = 0 }
}

const startPress = (event) => {
  if (event && event.pointerType === 'mouse' && event.button !== 0) return
  clearPressTimer()
  window.clearTimeout(pendingTimer)
  pendingToggle.value = false
  pressStartedPlaying.value = playback.playing
  longPressFired.value = false
  suppressPartialClick = false
  pressActive.value = true
  holdAnimating.value = false
  animationTimer = window.setTimeout(() => { animationTimer = 0; if (pressActive.value) { holdAnimating.value = true; suppressPartialClick = true } }, 100)
  pressTimer = window.setTimeout(() => {
    pressTimer = 0
    longPressFired.value = true
    pressActive.value = false
    pendingToggle.value = true
    holdAnimating.value = false
    emit('global-toggle')
    pendingTimer = window.setTimeout(() => { pendingToggle.value = false }, 3000)
  }, LONG_PRESS_MS)
}

const endPress = () => {
  clearPressTimer()
  pressActive.value = false
  holdAnimating.value = false
}

const cancelPress = () => {
  clearPressTimer()
  pressActive.value = false
  holdAnimating.value = false
  suppressPartialClick = false
}

const onCenterClick = (event) => {
  if (event?.detail === 0) { suppressPartialClick = false; longPressFired.value = false; emit('local-mute'); return }
  // 长按已经触发全局暂停：吞掉随后的 click，避免再切一次本机静音
  if (longPressFired.value) {
    longPressFired.value = false
    return
  }
  if (suppressPartialClick) { suppressPartialClick = false; return }
  emit('local-mute')
}

const centerIcon = computed(() => {
  if (playback.muted) return VolumeX
  return playback.playing ? Pause : Play
})

const centerLabel = computed(() => {
  if (playback.muted) return '本机已静音 · 单击恢复声音，长按 0.5 秒暂停房间'
  return playback.playing
    ? '单击静音本机（不影响房间） · 长按 0.5 秒暂停房间'
    : '单击静音本机（不影响房间） · 长按 0.5 秒恢复房间'
})

const volumeLabel = computed(() =>
  playback.muted ? '取消本机静音' : '静音本机（不影响房间）'
)

let timer = 0
onMounted(() => {
  window.addEventListener('resize', placeLyricMenu)
  window.addEventListener('scroll', placeLyricMenu, true)
  document.addEventListener('pointerdown', dismissLyricMenu, true)
  document.addEventListener('keydown', closeLyricMenuOnEscape, true)
  if (props.live) return
  timer = window.setInterval(() => { if (!engine.track) tickPlayback() }, 1000)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', placeLyricMenu)
  window.removeEventListener('scroll', placeLyricMenu, true)
  document.removeEventListener('pointerdown', dismissLyricMenu, true)
  document.removeEventListener('keydown', closeLyricMenuOnEscape, true)
  window.clearInterval(timer)
  window.clearTimeout(pendingTimer)
  clearPressTimer()
})
</script>

<template>
  <div class="workspace">
    <div class="workspace-inner">
      <div v-if="!nowPlaying" class="empty-state reveal reveal-1">
        <div class="empty-mark">♪</div>
        <div class="empty-title">房间还没有在播放的歌</div>
        <div class="empty-text">
          连接房间后，在「搜索」里点一首歌，所有人会同一秒听到。
        </div>
        <button class="btn-primary" @click="emit('search')">去搜索点歌</button>
        <button v-if="live" class="btn-ghost" @click="emit('refresh-list')">刷新列表</button>
        <div v-if="live" class="empty-text">同步房间状态；有待播歌曲且没有正在播放的歌曲时，会尝试启动播放。</div>
      </div>

      <template v-else>
      <section class="hero reveal reveal-1" :class="{ 'hint-visible': pauseHint || lyricMenuOpen }">
        <button class="hero-cover hero-cover-like" type="button" :aria-label="nowPlaying.likedByMe ? '已点赞当前歌曲' : '点赞当前歌曲'" @click="emit('like')">
          <TrackCover :cover="nowPlaying.cover" />
          <Heart class="cover-like-icon" :class="{ liked: nowPlaying.likedByMe }" :size="36" :fill="nowPlaying.likedByMe ? 'currentColor' : 'none'" />
        </button>

        <div class="hero-body">
          <div class="hero-kicker">
            <span class="live-dot"></span>
            {{ playback.playing ? '正在播放' : '已暂停' }}
            <span class="sep"></span>
            {{ nowPlaying.sourceLabel }}
          </div>

          <h1 class="hero-title">{{ nowPlaying.title }}</h1>
          <div class="hero-artist">
            {{ nowPlaying.artist }}
            <span v-if="nowPlaying.album" class="hero-album">· {{ nowPlaying.album }}</span>
          </div>

          <div class="hero-chips">
            <span class="chip">点歌 · {{ nowPlaying.requestedBy }}</span>
            <button class="chip hero-like" :class="{ liked: nowPlaying.likedByMe }" :aria-pressed="!!nowPlaying.likedByMe" @click="emit('like')">
              <Heart :size="11" :stroke-width="2" :fill="nowPlaying.likedByMe ? 'currentColor' : 'none'" />
              {{ nowPlaying.liked }}
            </button>
            <span
              v-if="nowPlaying.trial"
              class="chip"
              title="服务端仅提供试听片段；进度按实际可播时长锚定，不代表完整曲目"
            >
              {{ nowPlaying.trialDurationKnown ? `试听 · ${fmt(nowPlaying.playableDuration || nowPlaying.duration)}` : '试听 · 时长未确定' }}
            </span>
            <span class="chip solid">现场同步</span>
          </div>

          <div class="hero-spacer"></div>

          <div class="progress">
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: `${pct}%` }"></div>
              <div class="progress-handle" :style="{ left: `${pct}%` }"></div>
              <input v-if="canSeek" class="room-seek" type="range" min="0" :max="nowPlaying.duration" step="1" :value="playback.progress" aria-label="调整房间播放进度" @pointerdown="rememberSeekPlayback" @focus="rememberSeekPlayback" @change="commitSeek" />
            </div>
            <div class="progress-times">
              <span>{{ fmt(playback.progress) }}</span>
              <span>{{ fmt(nowPlaying.duration) }}</span>
            </div>
          </div>

          <div class="transport">
            <select v-if="live && playMode" class="mode-picker" :value="playMode" :disabled="modeLocked" aria-label="房间播放模式" @change="changeMode">
              <option value="SEQUENTIAL">顺序播放</option><option value="SHUFFLE">随机播放</option><option value="ROUND_ROBIN">成员轮询</option><option value="REPEAT_ONE">单曲循环</option>
            </select>
            <button class="icon-btn" :class="{ on: live && playMode === 'SHUFFLE' }" title="随机播放" :disabled="live && (!playMode || modeLocked)" @click="live && playMode && emit('play-mode', playMode === 'SHUFFLE' ? 'SEQUENTIAL' : 'SHUFFLE')">
              <Shuffle :size="15" :stroke-width="1.8" />
            </button>
            <button class="icon-btn" title="上一首" @click="emit('skip')">
              <SkipBack :size="16" :stroke-width="1.8" />
            </button>
            <button
              class="transport-play"
              :class="{ 'is-muted': playback.muted, 'is-pressing': pressActive }"
              type="button"
              :title="centerLabel"
              :aria-label="centerLabel"
              :aria-pressed="playback.muted"
              @pointerdown="startPress"
              @pointerup="endPress"
              @pointerleave="cancelPress"
              @pointercancel="cancelPress"
              @click="onCenterClick"
            >
              <component :is="centerIcon" :size="18" :stroke-width="2" />
              <svg class="hold-ring" viewBox="0 0 44 44" aria-hidden="true">
                <path class="hold-ring-track" d="M 7 31 A 17 17 0 1 1 37 31" pathLength="100" />
                <path class="hold-ring-progress" :class="{ filling: holdAnimating }" :d="pressStartedPlaying ? 'M 37 31 A 17 17 0 1 0 7 31' : 'M 7 31 A 17 17 0 1 1 37 31'" pathLength="100" />
                <circle class="hold-ring-dot" :class="{ 'dot-at-right': dotAtRight, moving: holdAnimating }" cx="0" cy="0" r="1.8" />
              </svg>
            </button>
            <button class="icon-btn" title="下一首" @click="emit('skip')">
              <SkipForward :size="16" :stroke-width="1.8" />
            </button>
            <button class="icon-btn" :class="{ on: live ? playMode === 'REPEAT_ONE' : true }" title="单曲循环" :disabled="live && (!playMode || modeLocked)" @click="live && playMode && emit('play-mode', playMode === 'REPEAT_ONE' ? 'SEQUENTIAL' : 'REPEAT_ONE')">
              <Repeat2 :size="15" :stroke-width="1.8" />
            </button>

            <button v-if="desktopLyricsAvailable" class="icon-btn" :class="{ on: desktopLyricsOpen }" type="button" :title="desktopLyricsOpen ? '关闭桌面歌词' : '打开桌面歌词'" :aria-label="desktopLyricsOpen ? '关闭桌面歌词' : '打开桌面歌词'" :aria-pressed="desktopLyricsOpen" @click="emit('toggle-desktop-lyrics')">
              <Captions :size="17" :stroke-width="1.8" />
            </button>
            <div v-if="desktopLyricsAvailable" class="lyrics-menu-wrap">
              <button ref="lyricMenuAnchor" class="icon-btn lyrics-menu-toggle" type="button" :aria-expanded="lyricMenuOpen" :aria-label="lyricMenuOpen ? '收起桌面歌词设置' : '展开桌面歌词设置'" @click="toggleLyricMenu"><component :is="lyricMenuOpen ? ChevronDown : ChevronUp" :size="15" /></button>
              <Teleport to="body"><div v-if="lyricMenuOpen" ref="lyricMenuPanel" class="lyrics-menu" :style="lyricMenuPosition" role="group" aria-label="桌面歌词设置">
                <strong>桌面歌词设置</strong>
                <div class="lyrics-rgb"><label>自定义颜色 <input type="color" :value="lyricStyle.color" aria-label="桌面歌词自定义颜色" @input="updateLyricStyle({color:$event.target.value})" /></label><label v-for="(channel,i) in ['R','G','B']" :key="channel">{{ channel }}<input type="number" min="0" max="255" :value="rgbValue(i)" :aria-label="'歌词颜色 '+channel" @change="setRgb(i,$event)" /></label></div>
                <div class="lyrics-presets"><button v-for="color in lyricColors" :key="color.value" type="button" :aria-pressed="lyricStyle.color === color.value" @click="updateLyricStyle({color:color.value})"><i :style="{background:color.value}"></i>{{ color.label }}</button></div>
                <label class="lyrics-option">字体 <select :value="lyricStyle.font" @change="updateLyricStyle({font:$event.target.value})"><option v-for="font in lyricFonts" :key="font.id" :value="font.id">{{ font.label }}</option></select></label>
                <label class="lyrics-option"><input type="checkbox" :checked="lyricStyle.fill" @change="updateLyricStyle({fill:$event.target.checked})" />颜色覆盖</label>
                <label class="lyrics-option"><input type="checkbox" :checked="lyricStyle.wave" @change="updateLyricStyle({wave:$event.target.checked})" />字符波浪</label>
                <label class="lyrics-option"><input type="checkbox" :checked="lyricStyle.border" @change="updateLyricStyle({border:$event.target.checked})" />显示边框</label>
                <label class="lyrics-option">边框粗细 <input type="range" min="1" max="10" :value="lyricStyle.borderWidth" @input="updateLyricStyle({borderWidth:Number($event.target.value)})" /> {{ lyricStyle.borderWidth }}px</label>
                <label class="lyrics-option">边框透明度 <input type="range" min="0" max="100" :value="lyricStyle.borderOpacity" @input="updateLyricStyle({borderOpacity:Number($event.target.value)})" /> {{ lyricStyle.borderOpacity }}%</label>
                <label class="lyrics-option"><input type="checkbox" :checked="lyricStyle.glass" @change="updateLyricStyle({glass:$event.target.checked})" />柔光玻璃背景</label>
                <label class="lyrics-option">玻璃透明度 <input type="range" min="0" max="100" :value="lyricStyle.glassOpacity" @input="updateLyricStyle({glassOpacity:Number($event.target.value)})" /> {{ lyricStyle.glassOpacity }}%</label>
                <label class="lyrics-option"><input type="checkbox" :checked="lyricStyle.spectrum" @change="updateLyricStyle({spectrum:$event.target.checked})" />显示频谱图</label>
                <label class="lyrics-option">歌词字号 <input type="range" min="12" max="80" :value="lyricStyle.fontSize" @input="updateLyricStyle({fontSize:Number($event.target.value)})" /> {{ lyricStyle.fontSize }}px</label>
                <button type="button" class="btn-ghost" @click="resetLyrics">重置为预设</button>
                <small>按相邻歌词时间估算进度</small><small v-if="lyricMessage" role="alert">{{ lyricMessage }}</small>
              </div></Teleport>
            </div>
            <div class="transport-right">
              <div class="volume" :class="{ 'is-muted': playback.muted }">
                <button
                  class="icon-btn volume-btn"
                  type="button"
                  :title="volumeLabel"
                  :aria-label="volumeLabel"
                  @click="emit('local-mute')"
                >
                  <component :is="playback.muted ? VolumeX : Volume2" :size="15" :stroke-width="1.8" />
                </button>
                <div class="volume-track" @click="onVolumeClick">
                  <div class="volume-fill" :style="{ width: `${playback.volume}%` }"></div>
                </div>
              </div>
            </div>

            <div v-if="pauseHint" class="pause-hint" role="status" aria-live="polite">
              <div class="pause-hint-head">
                <VolumeX :size="13" :stroke-width="2" />
                <span>本机静音 · 只影响你自己</span>
                <button
                  class="pause-hint-close"
                  type="button"
                  aria-label="关闭说明"
                  @click="emit('dismiss-pause-hint')"
                >
                  ×
                </button>
              </div>
              <p class="pause-hint-text">
                单击播放键只会静音<b>本机</b>的声音，不影响房间里的其他人；
                长按播放键 <b>0.5 秒</b> 或按住空格 <b>1 秒</b> 可暂停 / 恢复房间（需要成员权限）。
              </p>
              <div class="pause-hint-foot">
                <span class="pause-hint-kbd">长按 0.5s = 暂停房间</span>
                <button class="pause-hint-ok" type="button" @click="emit('dismiss-pause-hint')">
                  知道了
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="party-lower">
        <section class="panel surface reveal reveal-2">
          <div class="panel-head">
            <span class="label">实时频谱 · SPECTRUM</span>
            <span class="label">
              {{
                engine.ready
                  ? engine.hasAnalyser
                    ? '实时频谱 · STEREO'
                    : '降级 · 合成波形'
                  : '合成波形 · 待播放'
              }}
            </span>
          </div>
          <div class="viz-wrap">
            <Visualizer :active="playback.playing" />
          </div>
        </section>

        <section class="panel reveal reveal-3">
          <div class="panel-head">
            <span class="label">歌词 · LYRICS</span>
            <span class="label">滚动 · 自动</span>
          </div>
          <LyricsPanel :lines="lyrics" :progress="playback.progress" />
        </section>
      </div>

      <section class="panel reveal reveal-4">
        <div class="panel-head">
          <span class="label">接下来 · UP NEXT</span>
          <button class="text-btn" @click="emit('show-queue')">查看完整队列 ↗</button>
        </div>
        <div class="upnext-list">
          <div v-for="item in (live ? queue.slice(0, 4) : queue.slice(1, 5))" :key="item.queueId || item.id" class="upnext-row">
            <div class="upnext-cover"><TrackCover :cover="item.cover" small /></div>
            <div class="upnext-info">
              <span class="upnext-title">{{ item.title }}</span>
              <span class="upnext-artist">{{ item.artist }} · {{ item.sourceLabel }}</span>
            </div>
            <span class="upnext-by">{{ item.requestedBy }}</span>
            <span class="upnext-dur">{{ fmt(item.duration) }}</span>
          </div>
        </div>
      </section>
      </template>
    </div>
  </div>
</template>
<style scoped>
.lyrics-menu-wrap { position:relative; flex:none; }
.lyrics-menu-toggle { width:25px; }
.lyrics-menu { position:fixed; z-index:2147482000; overflow:auto; box-sizing:border-box; padding:12px; display:flex; flex-direction:column; gap:10px; border:1px solid var(--line); border-radius:8px; background:var(--canvas); color:var(--ink); box-shadow:0 8px 24px #0004; font-size:12px; }
.lyrics-menu strong { font-size:13px; }
.lyrics-rgb,.lyrics-presets { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.lyrics-rgb label,.lyrics-option { display:flex; align-items:center; gap:4px; }
.lyrics-rgb input[type=number] { width:46px; }
.lyrics-rgb input[type=color] { width:34px; height:27px; padding:1px; }
.lyrics-menu input,.lyrics-menu select { color:var(--ink); background:var(--canvas); border:1px solid var(--line); }
.lyrics-presets button { display:inline-flex; align-items:center; gap:3px; color:var(--ink); padding:4px; border:1px solid var(--line); border-radius:4px; }
.lyrics-presets button[aria-pressed=true] { border-color:var(--accent); outline:1px solid var(--accent); }
.lyrics-presets i { width:14px; height:14px; border-radius:50%; border:1px solid #888; }
.room-seek { position:absolute; left:0; top:-8px; width:100%; height:20px; margin:0; opacity:.01; cursor:pointer; }
.room-seek:focus-visible { opacity:.8; outline:2px solid currentColor; }
.mode-picker { max-width:110px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--ink); padding:5px; }
.transport-play { position: relative; }
.hold-ring { position:absolute; inset:2px; width:calc(100% - 4px); height:calc(100% - 4px); pointer-events:none; }
.hold-ring-track,.hold-ring-progress { fill:none; stroke-width:2.5; stroke-linecap:round; }
.hold-ring-track { stroke:rgba(255,205,56,.18); opacity:0; transition:opacity .2s; }
.is-pressing .hold-ring-track { opacity:1; transition-delay:.1s; }
.hold-ring-progress { stroke:#ffcd38; stroke-dasharray:100; stroke-dashoffset:100; transition:stroke-dashoffset .2s ease-out; }
.hold-ring-progress.filling { stroke-dashoffset:0; transition:stroke-dashoffset .4s linear; }
.hold-ring-dot { fill:var(--accent); offset-path:path('M 7 31 A 17 17 0 1 1 37 31'); offset-distance:0%; transition:offset-distance .2s ease-out; }
.hold-ring-dot.dot-at-right { offset-distance:100%; }
.hold-ring-dot.moving { transition:offset-distance .4s linear; }
@media (prefers-reduced-motion:reduce) { .hold-ring-progress,.hold-ring-dot { transition:none; } }
</style>

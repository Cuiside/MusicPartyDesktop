<script setup>
/**
 * 系统托盘状态卡（TrayCard.vue）。
 *
 * 渲染在独立的 frameless 小窗口里（主进程 `electron/tray.cjs` 加载
 * `dist/index.html?tray=1`，开发环境 `http://localhost:5173/?tray=1`）。
 * 由 App.vue 在 `?tray=1` 分支只渲染本组件（App.vue 属于 audio-engine 的写入范围）。
 *
 * 数据来源：主进程缓存的 `{ title, artist, coverUrl, liked, muted, playing }`
 * （主窗口通过 tray-bridge.pushTrayState 推送）；本组件只读缓存、发命令，不建立 live 连接。
 *
 * 调试/截图参数（dev）：
 *   ?tray=1&trayPreview=1  → 使用内置演示歌曲状态，便于无 live 连接时截图视觉。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Heart, Monitor, Power, Volume2, VolumeX } from 'lucide-vue-next'
import {
  hideCard,
  quitApp,
  requestTrayState,
  sendTrayCommand,
  showMain,
  tray
} from '../core/tray-bridge'

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
const baseUrl = import.meta.env.BASE_URL
/** 仅截图/视觉预览使用：不连 live、不依赖主进程缓存。 */
const previewMode = params.get('trayPreview') === '1'
const previewState = ref({
  title: 'Midnight City',
  artist: 'M83',
  coverUrl: '',
  liked: true,
  muted: false,
  playing: true
})

const state = computed(() => (previewMode ? previewState.value : tray))
const coverFailed = ref(false)
watch(() => state.value.coverUrl, () => { coverFailed.value = false })

const hasTrack = computed(() => Boolean(state.value.title))
const canLike = computed(() => hasTrack.value)
const coverSrc = computed(() => (coverFailed.value ? '' : state.value.coverUrl || ''))

const statusText = computed(() => {
  if (!hasTrack.value) return '待机'
  if (state.value.muted) return '已静音'
  if (state.value.playing) return '播放中'
  return '已暂停'
})

const toggleLike = () => {
  if (!canLike.value) return
  if (previewMode) {
    previewState.value = { ...previewState.value, liked: !previewState.value.liked }
    return
  }
  // 乐观反馈；主窗口执行 liveLike() 后会推送权威状态。
  tray.liked = !tray.liked
  sendTrayCommand('like')
}

const toggleMute = () => {
  if (previewMode) {
    previewState.value = { ...previewState.value, muted: !previewState.value.muted }
    return
  }
  tray.muted = !tray.muted
  sendTrayCommand('local-mute')
}

const onKeydown = (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    hideCard()
  }
}

onMounted(async () => {
  if (!previewMode) await requestTrayState()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <section class="tray-card" role="dialog" aria-label="Music Party 托盘状态卡">
    <header class="tc-head">
      <div class="tc-brand">
        <span class="tc-mark" aria-hidden="true"><img :src="`${baseUrl}musicparty-logo.png`" alt="" /></span>
        <span class="tc-brandtext">
          <span class="tc-name">MUSIC PARTY</span>
          <span class="tc-sub">系统托盘</span>
        </span>
      </div>
      <span class="tc-state" :class="{ live: hasTrack && state.playing && !state.muted, muted: state.muted }">
        <span class="tc-dot" aria-hidden="true"></span>
        {{ statusText }}
      </span>
    </header>

    <section class="tc-now">
      <div class="tc-cover" :class="{ spinning: hasTrack && state.playing && !state.muted }">
        <img
          v-if="coverSrc"
          :src="coverSrc"
          alt=""
          draggable="false"
          @error="coverFailed = true"
        />
        <div v-else class="tc-vinyl" aria-hidden="true">
          <span class="tc-vinyl-label"><img :src="`${baseUrl}musicparty-logo.png`" alt="" /></span>
        </div>
      </div>

      <div class="tc-meta">
        <span class="tc-eyebrow">
          <span
            v-if="hasTrack && state.playing && !state.muted"
            class="tc-eq"
            aria-hidden="true"
          >
            <i></i><i></i><i></i>
          </span>
          {{ hasTrack ? (state.playing ? '正在播放' : '已暂停') : '暂无播放' }}
        </span>
        <span class="tc-title" :title="state.title || ''">
          {{ hasTrack ? state.title : '在主界面开始播放后显示' }}
        </span>
        <span class="tc-artist">
          {{ hasTrack ? state.artist || '本地播放' : '这里会同步当前歌曲与点赞状态' }}
        </span>
      </div>

      <button
        class="tc-like"
        :class="{ active: state.liked }"
        :disabled="!canLike"
        :aria-pressed="state.liked"
        :title="state.liked ? '取消点赞' : '点赞'"
        @click="toggleLike"
      >
        <Heart :size="15" :stroke-width="2" :fill="state.liked ? 'currentColor' : 'none'" />
      </button>
    </section>

    <footer class="tc-actions">
      <button
        class="tc-btn"
        :class="{ active: state.muted }"
        :aria-pressed="state.muted"
        :title="state.muted ? '恢复本地播放声音' : '只静音本机播放，不影响房间'"
        @click="toggleMute"
      >
        <VolumeX v-if="state.muted" :size="13" :stroke-width="2" />
        <Volume2 v-else :size="13" :stroke-width="2" />
        {{ state.muted ? '取消静音' : '本地静音' }}
      </button>
      <button class="tc-btn primary" title="显示主界面" @click="showMain()">
        <Monitor :size="13" :stroke-width="2" />
        显示主界面
      </button>
      <button class="tc-btn icon" title="退出应用" aria-label="退出应用" @click="quitApp()">
        <Power :size="13" :stroke-width="2" />
      </button>
    </footer>

    <div class="tc-foot">
      <span>ESC 隐藏</span>
      <span class="tc-foot-brand">MUSIC PARTY · TRAY</span>
    </div>
  </section>
</template>

<style scoped>
.tray-card {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  color: var(--ink-2, #141414);
  background: var(--shell, #ffcd38);
  border: 1px solid var(--shell-line, #e0ae00);
  font-family: var(--font, 'Space Grotesk', 'Microsoft YaHei UI', 'PingFang SC', system-ui, sans-serif);
  user-select: none;
  -webkit-user-select: none;
}

.tc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--shell-line, #e0ae00);
  flex: none;
}

.tc-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tc-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  background: var(--ink-2, #141414);
  color: var(--inverse-text, #fcfcfd);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex: none;
}

.tc-brandtext {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  min-width: 0;
}

.tc-name {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.tc-sub {
  font-size: 9px;
  color: var(--muted, rgba(20, 20, 20, 0.62));
  letter-spacing: 0.08em;
}

.tc-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--muted, rgba(20, 20, 20, 0.62));
  white-space: nowrap;
}

.tc-dot {
  width: 6px;
  height: 6px;
  background: var(--muted-2, rgba(20, 20, 20, 0.42));
}

.tc-state.live .tc-dot {
  background: var(--ink-2, #141414);
}

.tc-state.muted {
  color: var(--danger, #a4262c);
}

.tc-state.muted .tc-dot {
  background: var(--danger, #a4262c);
}

.tc-now {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 10px;
  flex: 1;
  min-height: 0;
}

.tc-cover {
  position: relative;
  width: 88px;
  height: 88px;
  flex: none;
  border: 1px solid var(--ink-2, #141414);
  background: var(--ink-2, #141414);
  overflow: hidden;
}

.tc-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.tc-vinyl {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background:
    repeating-radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.08) 0 1px, transparent 1px 4px),
    radial-gradient(circle at 50% 50%, #2a2a2a 0 36%, #141414 36% 100%);
}

.tc-vinyl-label {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--shell, #ffcd38);
  color: var(--ink-2, #141414);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.tc-cover.spinning .tc-vinyl {
  animation: tc-spin 6s linear infinite;
}

@keyframes tc-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tc-cover.spinning .tc-vinyl {
    animation: none;
  }
}

.tc-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.tc-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--muted, rgba(20, 20, 20, 0.62));
  text-transform: uppercase;
}

.tc-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 1px;
  height: 8px;
}

.tc-eq i {
  width: 2px;
  height: 6px;
  background: currentColor;
  animation: tc-eq 720ms ease-in-out infinite alternate;
}

.tc-eq i:nth-child(2) {
  animation-delay: 140ms;
}

.tc-eq i:nth-child(3) {
  animation-delay: 280ms;
}

@keyframes tc-eq {
  from {
    height: 2px;
  }
  to {
    height: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tc-eq i {
    animation: none;
    height: 6px;
  }
}

.tc-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -0.01em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.tc-artist {
  font-size: 11px;
  color: var(--muted, rgba(20, 20, 20, 0.62));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tc-like {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: none;
  align-self: flex-start;
  margin-top: 2px;
  border: 1px solid var(--ink-2, #141414);
  background: transparent;
  color: var(--ink-2, #141414);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.tc-like:hover:not(:disabled) {
  background: rgba(20, 20, 20, 0.08);
}

.tc-like.active {
  background: var(--ink-2, #141414);
  color: var(--shell, #ffcd38);
}

.tc-like:disabled {
  opacity: 0.35;
  cursor: default;
}

.tc-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 10px;
  flex: none;
}

.tc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--ink-2, #141414);
  background: var(--canvas, #fcfcfd);
  color: var(--ink-2, #141414);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  cursor: pointer;
  white-space: nowrap;
}

.tc-btn:hover {
  background: var(--surface-strong, #efebe1);
}

.tc-btn.active {
  background: var(--ink-2, #141414);
  color: var(--canvas, #fcfcfd);
}

.tc-btn.primary {
  background: var(--ink-2, #141414);
  color: var(--canvas, #fcfcfd);
  flex: 1;
}

.tc-btn.primary:hover {
  background: #2b2b2b;
}

.tc-btn.icon {
  width: 30px;
  padding: 0;
}

.tc-btn:focus-visible,
.tc-like:focus-visible {
  outline: 2px solid var(--focus, #141414);
  outline-offset: 2px;
}

.tc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 20px;
  padding: 0 10px;
  flex: none;
  border-top: 1px solid var(--shell-line, #e0ae00);
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--muted, rgba(20, 20, 20, 0.62));
  background: var(--shell-alt, #f6c42a);
}

.tc-foot-brand {
  font-weight: 700;
}
</style>

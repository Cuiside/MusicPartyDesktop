<script setup>
import { computed, onMounted, ref } from 'vue'
import { Minus, Search, Settings, ShieldCheck, Square, X, Sun, Moon, CircleHelp } from 'lucide-vue-next'
import { appearance, setDarkMode } from '../core/appearance'
import { connection } from '../core/connection'
import { live } from '../core/live/state'

defineProps({
  room: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['settings', 'search', 'connect', 'admin', 'help'])
const baseUrl = import.meta.env.BASE_URL

const desktop = typeof window !== 'undefined' ? window.mpDesktop : undefined
const isMax = ref(false)

const connectedLabel = computed(() => {
  if (live.joined) {
    if (live.connected) return `已连接 · ${live.latency || 0}ms`
    return live.reconnecting ? '重连中…' : '连接已断开'
  }
  return connection.online ? `演示模式 · ${connection.latency}ms` : '离线'
})

const offline = computed(() => (live.joined ? !live.connected : !connection.online))

const modeLabel = computed(() => {
  if (live.joined) return `实时 · ${live.server}`
  return `DESKTOP · ${connection.mode}`
})

const refreshMax = async () => {
  if (!desktop) return
  isMax.value = await desktop.window.isMaximized()
}

const toggleMax = () => {
  if (!desktop) return
  desktop.window.toggleMaximize()
  setTimeout(refreshMax, 140)
}

onMounted(refreshMax)
</script>

<template>
  <header class="titlebar" @dblclick="toggleMax">
    <div class="brand">
      <a class="brand-mark brand-link" href="https://github.com/PluvIIter/MusicParty" target="_blank" rel="noopener noreferrer" title="打开 MusicParty 原仓库" aria-label="打开 MusicParty 原仓库" @dblclick.stop><img :src="`${baseUrl}musicparty-logo.png`" alt="MusicParty" /></a>
      <div class="brand-text">
        <span class="brand-name">MUSIC PARTY</span>
        <span class="brand-sub">{{ modeLabel }}</span>
      </div>
    </div>

    <button class="titlebar-search" title="打开命令面板（CTRL K）" @click="emit('search')">
      <Search :size="14" :stroke-width="1.8" />
      <span class="titlebar-placeholder">搜索歌曲、歌手或房间…</span>
      <span class="kbd">CTRL K</span>
    </button>

    <div class="titlebar-right">
      <div class="mode-switch" aria-label="明暗模式"><button :class="{active:!appearance.dark}" aria-label="浅色模式" :aria-pressed="!appearance.dark" @click="setDarkMode(false)"><Sun :size="15" /></button><button :class="{active:appearance.dark}" aria-label="深色模式" :aria-pressed="appearance.dark" @click="setDarkMode(true)"><Moon :size="15" /></button></div>
      <button
        class="conn"
        :class="{ offline }"
        title="加入 / 连接房间"
        @click="emit('connect')"
      >
        <span class="conn-dot"></span>
        {{ connectedLabel }}
      </button>
      <button class="tb-btn" title="管理员登录" aria-label="管理员登录" @click="emit('admin')">
        <ShieldCheck :size="15" :stroke-width="1.7" />
      </button>
      <button class="tb-btn" title="用户帮助" aria-label="用户帮助" @click="emit('help')"><CircleHelp :size="15" :stroke-width="1.7" /></button>
      <button class="tb-btn" title="设置" @click="emit('settings')">
        <Settings :size="15" :stroke-width="1.7" />
      </button>
      <button class="winbtn" title="最小化" @click="desktop?.window.minimize()">
        <Minus :size="14" />
      </button>
      <button class="winbtn" :title="isMax ? '还原' : '最大化'" @click="toggleMax">
        <Square :size="11" />
      </button>
      <button class="winbtn close" title="关闭" @click="desktop?.window.close()">
        <X :size="14" />
      </button>
    </div>
  </header>
</template>

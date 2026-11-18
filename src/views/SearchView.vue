<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, Plus, Search } from 'lucide-vue-next'
import TrackCover from '../components/TrackCover.vue'
import StateBlock from '../components/StateBlock.vue'
import PlaylistLibrary from '../components/PlaylistLibrary.vue'
import AlbumLibrary from '../components/AlbumLibrary.vue'
import { demo } from '../core/demo'
import { search as liveSearch } from '../core/live/client'
import { live } from '../core/live/state'

const props = defineProps({
  selectedId: { type: String, default: '' },
  liveMode: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'add'])

const query = ref('')
const platform = ref('netease')
const platformOptions = computed(() => {
  const labels = { netease: '网易云音乐', bilibili: 'Bilibili', qqmusic: 'QQ音乐' }
  const sources = live.config?.sources
  const ids = sources ? Object.keys(sources).filter(id => sources[id]?.enabled) : ['netease', 'bilibili']
  return ids.map(id => ({ id, label: labels[id] || id }))
})
const liveResults = ref([])
const loading = ref(false)
const error = ref('')
const added = ref(new Set())
const albumTrack = ref(null)
const timers = new Map()
let debounce = 0
let requestSeq = 0
watch(platformOptions, options => {
  if (!options.some(item => item.id === platform.value)) {
    requestSeq++
    platform.value = options[0]?.id || ''
    liveResults.value = []
    loading.value = false
  }
}, { immediate: true })

const demoResults = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return demo.searchResults
  return demo.searchResults.filter((s) =>
    `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q)
  )
})

const results = computed(() => (props.liveMode ? liveResults.value : demoResults.value))

const runSearch = async () => {
  if (!props.liveMode || !platform.value) return
  const term = query.value.trim()
  error.value = ''
  if (!term) {
    liveResults.value = []
    return
  }
  const seq = ++requestSeq
  loading.value = true
  try {
    const rows = await liveSearch(platform.value, term)
    if (seq === requestSeq) liveResults.value = rows
  } catch (err) {
    if (seq === requestSeq) {
      liveResults.value = []
      error.value = err?.message || '搜索失败'
    }
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(query, () => {
  if (!props.liveMode) return
  clearTimeout(debounce)
  debounce = setTimeout(runSearch, 320)
})

watch(
  () => props.liveMode,
  (value) => {
    if (value) runSearch()
    else {
      liveResults.value = []
      error.value = ''
    }
  }
)

const switchPlatform = (value) => {
  if (platform.value === value) return
  platform.value = value
  albumTrack.value = null
  runSearch()
}

const fmt = (seconds) => {
  if (!seconds) return '—'
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const isAdded = (id) => added.value.has(id)

const add = (song) => {
  emit('add', song)
  const next = new Set(added.value)
  next.add(song.id)
  added.value = next
  clearTimeout(timers.get(song.id))
  timers.set(
    song.id,
    setTimeout(() => {
      const s = new Set(added.value)
      s.delete(song.id)
      added.value = s
    }, 1800)
  )
}

const pick = (song) => emit('select', song)

onBeforeUnmount(() => {
  timers.forEach((t) => clearTimeout(t))
  clearTimeout(debounce)
})

defineExpose({ query })
</script>

<template>
  <div class="workspace">
    <div class="workspace-inner">
      <section class="search-hero reveal reveal-1">
        <div class="search-field">
          <Search class="search-icon" :size="18" :stroke-width="1.8" />
          <input v-model="query" placeholder="搜索歌曲、歌手、专辑…" spellcheck="false" />
          <span class="kbd">{{ liveMode ? '实时' : '演示' }}</span>
        </div>

        <div class="search-trending">
          <template v-if="liveMode">
            <span class="label">平台 · SOURCE</span>
            <button v-for="item in platformOptions" :key="item.id" class="chip-link"
              :class="{ active: platform === item.id }" @click="switchPlatform(item.id)">
              {{ item.label }}
            </button>
          </template>
          <template v-else>
            <span class="label">热门搜索 · TRENDING</span>
            <button v-for="t in demo.trending" :key="t" class="chip-link" @click="query = t">
              {{ t }}
            </button>
          </template>
        </div>
      </section>

      <PlaylistLibrary v-if="liveMode && platform" :platform="platform" @select="pick" @add="(song) => emit('add', song)" />
      <AlbumLibrary v-if="liveMode && albumTrack" :track="albumTrack" @close="albumTrack = null" @select="pick" @add="(song) => emit('add', song)" />

      <div class="panel search-results reveal reveal-2">
        <div class="panel-head">
          <span class="label">
            {{
              liveMode
                ? `搜索结果 · ${results.length} 条 · ${platformOptions.find(item => item.id === platform)?.label || '无可用音源'}`
                : query.trim()
                  ? `搜索结果 · ${results.length} 条 · 演示数据`
                  : `热门结果 · TRENDING · ${results.length} 条`
            }}
          </span>
          <span class="label">{{ liveMode ? '实时 API' : '按相关度' }}</span>
        </div>

        <div v-if="loading" class="state-inline">
          <StateBlock kind="loading" title="正在搜索…" text="正在从服务器拉取结果。" />
        </div>

        <div v-else-if="error" class="state-inline">
          <StateBlock
            kind="error"
            :title="`搜索失败：${error}`"
            text="检查服务器地址与网络连接；本地服务需要先启动。"
            action-label="重试"
            @action="runSearch"
          />
        </div>

        <div v-else-if="liveMode && !query.trim()" class="state-inline">
          <StateBlock
            kind="no-results"
            title="输入关键词开始搜索"
            text="搜索结果可直接点歌加入队列；可用音源由房间管理员配置。"
          />
        </div>

        <div v-else class="sresults">
          <div
            v-for="item in results"
            :key="item.id"
            class="srow sgrid"
            :class="{ active: item.id === selectedId }"
            @click="pick(item)"
          >
            <div class="scover"><TrackCover :cover="item.cover" small /></div>
            <div class="sinfo">
              <span class="stitle">{{ item.title }}</span>
              <span class="sartist">{{ item.artist }}</span>
            </div>
            <div class="salbum"><button v-if="liveMode && ['netease', 'qqmusic'].includes(item.source)" class="text-btn" @click.stop="albumTrack = item">查看专辑</button><template v-else>{{ item.album || '—' }}</template></div>
            <div class="ssource"><span class="source-chip">{{ item.sourceLabel }}</span></div>
            <div class="sdur">{{ fmt(item.duration) }}</div>
            <button class="sadd" :class="{ added: isAdded(item.id) }" @click.stop="add(item)">
              <component :is="isAdded(item.id) ? Check : Plus" :size="12" :stroke-width="2.1" />
              {{ isAdded(item.id) ? '已加入' : '点歌' }}
            </button>
          </div>

          <div v-if="!results.length" class="empty-state" style="margin: 16px">
            <div class="empty-mark">?</div>
            <div class="empty-title">没有找到结果</div>
            <div class="empty-text">换个关键词试试，或切换平台来源。</div>
          </div>
        </div>

        <div class="queue-foot">
          <span class="label">
            {{ liveMode ? '实时搜索 · 结果来自服务器' : '演示数据' }} · 共 {{ results.length }} 条
          </span>
          <span class="queue-foot-hint">点击「点歌」加入队列 · 点击行查看详情</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-trending .chip-link { color: var(--ink-2); }
.search-trending .chip-link.active { background: #141414; border-color: var(--ink-2); color: #ffcd38; }
</style>

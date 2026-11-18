<script setup>
import { Copy, Heart, Pin, Plus, Trash2, X } from 'lucide-vue-next'
import TrackCover from './TrackCover.vue'

const props = defineProps({
  song: { type: Object, required: true },
  mode: { type: String, default: 'queue' }
})
const emit = defineEmits(['close', 'action'])

const fmt = (seconds) => {
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
</script>

<template>
  <aside class="inspector">
    <div class="inspector-head">
      <span class="inspector-title">
        {{
          mode === 'search'
            ? '搜索结果 · RESULT'
            : mode === 'history'
              ? '播放记录 · HISTORY'
              : '曲目检查器 · TRACK'
        }}
      </span>
      <button class="icon-chip" title="关闭检查器" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>

    <div class="inspector-body">
      <section class="insp-section reveal reveal-1">
        <div class="track-card">
          <div class="track-cover">
            <TrackCover :cover="song.cover" />
          </div>
          <div class="track-meta">
            <div class="track-title">{{ song.title }}</div>
            <div class="track-artist">{{ song.artist }}</div>
            <div class="track-chips">
              <span class="chip">{{ song.sourceLabel }}</span>
              <span
                v-if="song.trial"
                class="chip"
                title="服务端仅提供试听片段；进度按实际可播时长锚定，不代表完整曲目"
              >
                {{ song.trialDurationKnown ? `试听 · ${fmt(song.playableDuration || song.duration)}` : '试听 · 时长未确定' }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section class="insp-section reveal reveal-2">
        <div class="insp-title"><span>信息 · INFO</span></div>
        <template v-if="mode === 'search'">
          <div class="kv"><span class="kv-k">专辑</span><span class="kv-v">{{ song.album || '—' }}</span></div>
          <div class="kv"><span class="kv-k">来源</span><span class="kv-v">{{ song.sourceLabel }}</span></div>
          <div class="kv"><span class="kv-k">时长</span><span class="kv-v">{{ fmt(song.duration) }}</span></div>
          <div class="kv"><span class="kv-k">热度</span><span class="kv-v">{{ song.liked }} 人点赞</span></div>
        </template>
        <template v-else-if="mode === 'history'">
          <div class="kv"><span class="kv-k">点歌人</span><span class="kv-v">{{ song.requestedBy }}</span></div>
          <div class="kv"><span class="kv-k">播放时间</span><span class="kv-v">{{ song.playedAt }}</span></div>
          <div class="kv"><span class="kv-k">专辑</span><span class="kv-v">{{ song.album || '—' }}</span></div>
          <div class="kv"><span class="kv-k">时长</span><span class="kv-v">{{ fmt(song.duration) }}</span></div>
        </template>
        <template v-else>
          <div class="kv"><span class="kv-k">点歌人</span><span class="kv-v">{{ song.requestedBy }}</span></div>
          <div class="kv"><span class="kv-k">专辑</span><span class="kv-v">{{ song.album || '—' }}</span></div>
          <div class="kv"><span class="kv-k">时长</span><span class="kv-v">{{ fmt(song.duration) }}</span></div>
          <div class="kv"><span class="kv-k">加入时间</span><span class="kv-v">{{ song.addedAt }}</span></div>
          <div class="kv">
            <span class="kv-k">状态</span>
            <span class="kv-v">
              {{ song.state === 'playing' ? '播放中' : song.pinned ? '已置顶' : '队列中' }}
            </span>
          </div>
        </template>
      </section>

      <section class="insp-section reveal reveal-3">
        <div class="insp-title"><span>操作 · ACTIONS</span></div>
        <div v-if="mode === 'search' || mode === 'history'" class="insp-actions">
          <button class="btn-ghost" @click="emit('action', 'add')">
            <Plus :size="13" :stroke-width="1.8" />
            {{ mode === 'history' ? '重新点歌' : '加入播放队列' }}
          </button>
          <button class="btn-ghost" @click="emit('action', 'copy')">
            <Copy :size="13" :stroke-width="1.8" />
            复制歌曲信息
          </button>
        </div>
        <div v-else class="insp-actions">
          <button class="btn-ghost" @click="emit('action', song.pinned ? 'unpin' : 'pin')">
            <Pin :size="13" :stroke-width="1.8" />
            {{ song.pinned ? '取消置顶' : '置顶到队首' }}
          </button>
          <button class="btn-ghost" @click="emit('action', 'like')">
            <Heart :size="13" :stroke-width="1.8" />
            点赞 · {{ song.liked }}
          </button>
          <button class="btn-ghost" @click="emit('action', 'copy')">
            <Copy :size="13" :stroke-width="1.8" />
            复制歌曲信息
          </button>
          <button class="btn-ghost danger" @click="emit('action', 'remove')">
            <Trash2 :size="13" :stroke-width="1.8" />
            从队列移除
          </button>
        </div>
      </section>

      <section v-if="mode === 'queue'" class="insp-section reveal reveal-4">
        <div class="insp-title"><span>动态 · ACTIVITY</span></div>
        <div class="activity-row">
          <span class="activity-time">{{ song.addedAt }}</span>
          <span>{{ song.requestedBy }} 点了《{{ song.title }}》</span>
        </div>
        <div v-if="song.pinned" class="activity-row">
          <span class="activity-time">—</span>
          <span>被置顶到队列前方</span>
        </div>
        <div class="activity-row">
          <span class="activity-time">—</span>
          <span>{{ song.liked }} 人点赞了这首歌</span>
        </div>
      </section>

      <section v-else class="insp-section reveal reveal-4">
        <div class="insp-title"><span>提示 · HINT</span></div>
        <div class="empty-text" style="max-width: none">
          {{
            mode === 'history'
              ? '这首歌在 ' + song.playedAt + ' 播放过，可以重新点歌加入当前队列。'
              : '选中结果后可在右侧加入播放队列；全局搜索（CTRL K）也可以直接点歌。'
          }}
        </div>
      </section>
    </div>
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  ArrowUpToLine,
  Check,
  Copy,
  GripVertical,
  Heart,
  MoreHorizontal,
  Pin,
  Trash2
} from 'lucide-vue-next'
import TrackCover from './TrackCover.vue'
import ContextMenu from './ContextMenu.vue'

const props = defineProps({
  queue: { type: Array, required: true },
  selectedId: { type: String, default: '' },
  selection: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'toggle', 'reorder', 'action'])

const dragging = ref(-1)
const dropIndex = ref(-1)
const menu = ref(null)

const fmt = (seconds) => {
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const isSel = (id) => props.selection.includes(id)

/* ---------- drag & drop reorder ---------- */
const onDragStart = (i, e) => {
  if (props.disabled) {
    e.preventDefault()
    return
  }
  dragging.value = i
  dropIndex.value = i
  e.dataTransfer.effectAllowed = 'move'
  try {
    e.dataTransfer.setData('text/plain', String(i))
  } catch {
    /* ignore */
  }
}

const onDragOver = (i, e) => {
  if (props.disabled || dragging.value < 0) return
  const rect = e.currentTarget.getBoundingClientRect()
  dropIndex.value = i + (e.clientY < rect.top + rect.height / 2 ? 0 : 1)
  e.dataTransfer.dropEffect = 'move'
}

const onDrop = () => {
  if (props.disabled) return
  const from = dragging.value
  if (from < 0) return
  let to = dropIndex.value < 0 ? 0 : dropIndex.value
  const next = props.queue.slice()
  const [moved] = next.splice(from, 1)
  if (from < to) to -= 1
  next.splice(to, 0, moved)
  emit('reorder', { next, moved })
  dragging.value = -1
  dropIndex.value = -1
}

const endDrag = () => {
  dragging.value = -1
  dropIndex.value = -1
}

const dropClass = (i) => {
  if (dragging.value < 0 || dropIndex.value < 0) return ''
  if (dropIndex.value === i) return 'drop-before'
  if (i === props.queue.length - 1 && dropIndex.value >= props.queue.length) return 'drop-after'
  return ''
}

/* ---------- context menu ---------- */
const openMenu = (item, e) => {
  e.preventDefault()
  menu.value = { x: e.clientX, y: e.clientY, item }
}

const menuItems = computed(() => {
  const item = menu.value?.item
  if (!item) return []
  return [
    { id: 'top', label: '置顶到队首', icon: ArrowUpToLine },
    item.pinned
      ? { id: 'unpin', label: '取消置顶', icon: Pin }
      : { id: 'pin', label: '置顶', icon: Pin },
    { id: 'like', label: '点赞', icon: Heart },
    { id: 'copy', label: '复制歌曲信息', icon: Copy },
    ...(item.canClaim ? [{ id: 'claim', label: '认领该成员歌单', icon: Check }] : []),
    { id: 'remove', label: '从队列移除', icon: Trash2, danger: true }
  ]
})

const onMenuSelect = (action) => {
  const item = menu.value?.item
  menu.value = null
  if (item) emit('action', { action, item })
}
</script>

<template>
  <div class="qbody">
    <TransitionGroup name="qrow" tag="div" class="qrows">
      <div
        v-for="(item, i) in queue"
        :key="item.id"
        class="qrow qgrid"
        :class="[
          dropClass(i),
          {
            playing: item.state === 'playing',
            selected: isSel(item.id),
            active: item.id === selectedId,
            dragging: dragging === i,
            pinned: item.pinned
          }
        ]"
        :draggable="!disabled"
        @dragstart="onDragStart(i, $event)"        @dragover.prevent="onDragOver(i, $event)"
        @drop.prevent="onDrop()"
        @dragend="endDrag"
        @click="emit('select', item.id)"
        @contextmenu="openMenu(item, $event)"
      >
        <div class="col-check" @click.stop>
          <button
            class="check"
            :class="{ on: isSel(item.id) }"
            :aria-label="isSel(item.id) ? '取消选择' : '选择'"
            @click="emit('toggle', { item, index: i, shift: $event.shiftKey })"
          >
            <Check v-if="isSel(item.id)" :size="11" :stroke-width="2.6" />
          </button>
        </div>

        <div class="col-track">
          <span v-if="item.state === 'playing'" class="eq" aria-hidden="true">
            <i></i><i></i><i></i><i></i>
          </span>
          <span v-else class="drag-handle" title="拖拽排序">
            <GripVertical :size="12" :stroke-width="1.8" />
          </span>
          <span class="qcover"><TrackCover :cover="item.cover" small /></span>
          <span class="qtitle">{{ item.title }}</span>
          <span
            v-if="item.trial"
            class="trial-flag"
            style="margin-left: 6px; font-size: 9px; font-weight: 700; letter-spacing: 0.04em; opacity: 0.75"
            title="服务端仅提供试听片段；进度按实际可播时长锚定，不代表完整曲目"
          >{{ item.trialDurationKnown ? `试听 · ${fmt(item.playableDuration || item.duration)}` : '试听 · 时长未确定' }}</span>
          <Pin v-if="item.pinned" class="pin-flag" :size="10" :stroke-width="2" />
        </div>

        <div class="col-artist">{{ item.artist }}</div>
        <div class="col-source">
          <span class="source-chip" :class="item.source">{{ item.sourceLabel }}</span>
        </div>
        <div class="col-by" :title="item.requestedBy || '未知成员'">{{ item.requestedBy || '未知成员' }}</div>
        <div class="col-likes">
          <Heart :size="10" :stroke-width="2" />
          {{ item.liked }}
        </div>
        <div class="col-dur">{{ fmt(item.duration) }}</div>

        <div class="col-actions" @click.stop>
          <button
            class="row-btn"
            :class="{ on: item.pinned }"
            title="置顶"
            @click="emit('action', { action: item.pinned ? 'unpin' : 'pin', item })"
          >
            <Pin :size="12" :stroke-width="1.9" />
          </button>
          <button
            class="row-btn"
            :class="{ on: item.likedByMe }"
            title="点赞"
            @click="emit('action', { action: 'like', item })"
          >
            <Heart :size="12" :stroke-width="1.9" />
          </button>
          <button class="row-btn" title="更多" @click="openMenu(item, $event)">
            <MoreHorizontal :size="13" :stroke-width="1.9" />
          </button>
        </div>
      </div>
    </TransitionGroup>

    <div v-if="!queue.length" class="empty-state" style="margin: 16px">
      <div class="empty-mark">0</div>
      <div class="empty-title">队列是空的</div>
      <div class="empty-text">搜索并点一首歌，队列会实时同步到房间里所有人。</div>
    </div>
  </div>

  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    @select="onMenuSelect"
    @close="menu = null"
  />
</template>

<script setup>
import { computed, ref } from 'vue'
import { Check, Heart, Pin, Trash2 } from 'lucide-vue-next'
import QueueTable from '../components/QueueTable.vue'

const props = defineProps({
  queue: { type: Array, required: true },
  selectedId: { type: String, default: '' },
  live: { type: Boolean, default: false },
  allowReorder: { type: Boolean, default: false },
  showRefresh: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'reorder', 'action', 'refresh-list'])

const selection = ref([])
const lastIndex = ref(-1)

const allSelected = computed(
  () => props.queue.length > 0 && selection.value.length === props.queue.length
)

const totalLabel = computed(() => {
  const total = props.queue.reduce((n, s) => n + s.duration, 0)
  return `${Math.floor(total / 60)} 分 ${String(total % 60).padStart(2, '0')} 秒`
})

const toggleAll = () => {
  selection.value = allSelected.value ? [] : props.queue.map((s) => s.id)
}

const onToggle = ({ item, index, shift }) => {
  const next = new Set(selection.value)
  if (shift && lastIndex.value >= 0) {
    const from = Math.min(lastIndex.value, index)
    const to = Math.max(lastIndex.value, index)
    for (let i = from; i <= to; i++) next.add(props.queue[i].id)
  } else if (next.has(item.id)) {
    next.delete(item.id)
  } else {
    next.add(item.id)
  }
  selection.value = [...next]
  lastIndex.value = index
}

const bulk = (action) => {
  if (!selection.value.length) return
  const ids = [...selection.value]
  emit('action', { action, ids })
  if (action === 'remove') selection.value = []
}

const onAction = (payload) => {
  if (payload.action === 'remove') {
    selection.value = selection.value.filter((id) => id !== payload.item.id)
  }
  emit('action', payload)
}

const onReorder = (next) => emit('reorder', next)
</script>

<template>
  <div class="workspace">
    <div class="workspace-inner">
      <div class="seltoolbar" :class="{ on: selection.length > 0 }">
        <span class="sel-count">{{ selection.length }} 项已选</span>
        <button class="chip-btn" @click="bulk('pin')">
          <Pin :size="12" :stroke-width="1.9" />
          置顶
        </button>
        <button class="chip-btn" @click="bulk('like')">
          <Heart :size="12" :stroke-width="1.9" />
          点赞
        </button>
        <button class="chip-btn" @click="bulk('remove')">
          <Trash2 :size="12" :stroke-width="1.9" />
          移除
        </button>
        <div class="cmd-spacer"></div>
        <button class="text-btn" @click="selection = []">取消选择</button>
      </div>

      <div class="queue-table panel reveal reveal-1">
        <div class="qhead qgrid">
          <div class="col-check">
            <button
              class="check"
              :class="{ on: allSelected }"
              :aria-label="allSelected ? '取消全选' : '全选'"
              @click="toggleAll"
            >
              <Check v-if="allSelected" :size="11" :stroke-width="2.6" />
            </button>
          </div>
          <span class="col-track">曲目</span>
          <span class="col-artist">歌手</span>
          <span class="col-source">来源</span>
          <span class="col-by">点歌人</span>
          <span class="col-likes">点赞</span>
          <span class="col-dur">时长</span>
          <span class="col-actions">操作</span>
        </div>

        <QueueTable
          :queue="queue"
          :selected-id="selectedId"
          :selection="selection"
          :disabled="live && !allowReorder"
          @select="(id) => emit('select', id)"
          @toggle="onToggle"
          @reorder="onReorder"
          @action="onAction"
        />

        <div v-if="showRefresh" class="queue-refresh"><button class="btn-ghost" @click="emit('refresh-list')">刷新列表</button><span>同步房间状态，并尝试启动待播歌曲。</span></div>
        <div class="queue-foot">
          <span class="label">共 {{ queue.length }} 首 · 总时长 {{ totalLabel }}</span>
          <span class="queue-foot-hint">{{ live && !allowReorder ? '切换到完整队列后可按房间权限排序 · 右键更多操作' : '拖拽行可排序 · 右键更多操作 · 点击行查看详情' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>.queue-refresh{display:flex;align-items:center;justify-content:center;gap:10px;padding:0 16px 16px;color:var(--muted);font-size:12px}</style>

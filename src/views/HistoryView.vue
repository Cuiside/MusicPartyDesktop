<script setup>
/**
 * 历史页：服务端没有历史接口（docs/AUDIT_HALLUCINATION.md P1-2）。
 *
 * - 真实房间模式：导航入口隐藏，若被外部参数强行打开则显示空态并说明原因；
 * - 演示模式：展示 demo.history 假数据，但表头/页脚/行数全部明确标注「演示数据」，
 *   不再展示 128 / 37 这类写死统计，也不提供「导出记录」假按钮。
 */
import { computed } from 'vue'
import { Plus } from 'lucide-vue-next'
import TrackCover from '../components/TrackCover.vue'
import StateBlock from '../components/StateBlock.vue'
import { demo } from '../core/demo'

const props = defineProps({
  selectedId: { type: String, default: '' },
  liveMode: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'add'])

const rows = computed(() => (props.liveMode ? [] : demo.history))

const fmt = (seconds) => {
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="workspace">
    <div class="workspace-inner">
      <div v-if="liveMode" class="panel reveal reveal-1">
        <div class="panel-head">
          <span class="label">播放历史 · HISTORY</span>
          <span class="label">服务端未提供</span>
        </div>
        <div class="panel-body">
          <StateBlock
            kind="empty"
            title="实时模式暂无历史记录"
            text="当前服务端没有历史接口，桌面端也不会伪造历史数据；实时房间内请用「队列」查看接下来要播放的歌曲。"
            action-label="返回队列"
          />
        </div>
      </div>

      <div v-else class="panel reveal reveal-1">
        <div class="panel-head">
          <span class="label">播放历史 · 演示数据（{{ rows.length }} 条）</span>
          <span class="label">演示模式 · 服务端未提供历史接口</span>
        </div>

        <div class="hhead hgrid">
          <span class="hblank"></span>
          <span class="col-track">曲目</span>
          <span class="halbum">专辑</span>
          <span class="hsource">来源</span>
          <span class="hby">点歌人</span>
          <span class="htime">播放时间</span>
          <span class="hdur">时长</span>
          <span class="hactions">操作</span>
        </div>

        <div class="hrows">
          <div
            v-for="item in rows"
            :key="item.id"
            class="hrow hgrid"
            :class="{ active: item.id === selectedId }"
            @click="emit('select', item)"
          >
            <div class="hcover"><TrackCover :cover="item.cover" small /></div>
            <div class="hinfo">
              <span class="stitle">{{ item.title }}</span>
              <span class="sartist">{{ item.artist }}</span>
            </div>
            <div class="halbum">{{ item.album || '—' }}</div>
            <div class="hsource"><span class="source-chip">{{ item.sourceLabel }}</span></div>
            <div class="hby">{{ item.requestedBy }}</div>
            <div class="htime">{{ item.playedAt }}</div>
            <div class="hdur">{{ fmt(item.duration) }}</div>
            <div class="hactions" @click.stop>
              <button class="sadd hadd" @click="emit('add', item)">
                <Plus :size="12" :stroke-width="2.1" />
                重新点歌
              </button>
            </div>
          </div>
        </div>

        <div class="queue-foot">
          <span class="label">演示数据 · 共 {{ rows.length }} 条（不是真实房间记录）</span>
          <span class="queue-foot-hint">点击行查看详情 · 右侧可重新点歌</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 命令栏（去装饰化版）。
 *
 * 只渲染真实可用的控件：
 * - 分段（segments）必须由 App 传入并监听 `@segment`，点击会真正切换数据筛选；
 * - 筛选 chip 已删除（原「音质 · 极高」「平台 · 全部」等只是样式，见 docs/AUDIT_HALLUCINATION.md P1-1）；
 * - 主操作（actionLabel）必须由 App 的 `@primary` 绑定真实动作，未接入时传空字符串。
 */
import { ref, watch } from 'vue'
import { PanelRight, Plus } from 'lucide-vue-next'

const props = defineProps({
  title: { type: String, required: true },
  kicker: { type: String, default: '' },
  segments: { type: Array, default: () => [] },
  activeSegment: { type: String, default: '' },
  actionLabel: { type: String, default: '' },
  actionTitle: { type: String, default: '' },
  inspectorOpen: { type: Boolean, default: true }
})
const emit = defineEmits(['toggle-inspector', 'primary', 'segment'])

const activeSeg = ref(props.activeSegment)
watch(
  () => props.activeSegment,
  (value) => (activeSeg.value = value)
)

const selectSegment = (id) => {
  activeSeg.value = id
  emit('segment', id)
}
</script>

<template>
  <div class="commandbar">
    <div class="cmd-title">
      <h1>{{ title }}</h1>
      <span class="cmd-kicker">{{ kicker }}</span>
    </div>

    <div class="cmd-spacer"></div>

    <div v-if="segments.length" class="segmented" role="tablist" aria-label="当前页面筛选">
      <button
        v-for="seg in segments"
        :key="seg.id"
        class="seg"
        :class="{ active: seg.id === activeSeg }"
        role="tab"
        :aria-selected="seg.id === activeSeg"
        :title="seg.title || ''"
        @click="selectSegment(seg.id)"
      >
        {{ seg.label }}
      </button>
    </div>

    <button
      v-if="actionLabel"
      class="btn-primary"
      :title="actionTitle || actionLabel"
      @click="emit('primary')"
    >
      <Plus class="plus" :size="14" :stroke-width="2.2" />
      {{ actionLabel }}
    </button>

    <button
      class="chip-btn icon-only"
      :class="{ pressed: inspectorOpen }"
      title="检查器面板"
      @click="emit('toggle-inspector')"
    >
      <PanelRight :size="14" :stroke-width="1.8" />
    </button>
  </div>
</template>

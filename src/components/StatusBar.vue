<script setup>
/**
 * 底部状态栏（真实状态版）。
 *
 * - 连接状态来自实时状态（live.connected / reconnecting），不再静态显示「已同步」；
 * - 演示模式明确标注「演示模式」；
 * - 删除无数据源的历史计数（服务端没有历史接口，见 AUDIT_HALLUCINATION P1-2/P2-6）；
 * - 快捷键按 node-15 的真实行为：SPACE = 本机静音、长按播放键 = 房间暂停、CTRL → = 切歌。
 */
import { computed } from 'vue'

const props = defineProps({
  room: { type: Object, required: true },
  live: { type: Object, default: null },
  demo: { type: Boolean, default: false }
})

const joined = computed(() => Boolean(props.live && props.live.joined))
const syncLabel = computed(() => {
  if (joined.value) {
    if (props.live.connected) return '已同步'
    return props.live.reconnecting ? '重连中' : '已断开'
  }
  return props.demo ? '演示模式' : '未连接'
})
const syncDotClass = computed(() => {
  if (joined.value && !props.live.connected) return 'warn'
  return ''
})
const latencyText = computed(() => {
  if (joined.value && props.live.connected) return `${props.live.latency || 0}ms`
  return ''
})
</script>

<template>
  <footer class="statusbar">
    <div class="status-item">
      <span class="dot" :class="syncDotClass"></span>
      <span class="status-strong">{{ syncLabel }}</span>
      <span v-if="latencyText">{{ latencyText }}</span>
    </div>
    <div class="status-item">
      <span class="status-strong">队列</span>
      <span>{{ room.queueCount }} 首</span>
    </div>
    <div class="status-item">
      <span class="status-strong">在线</span>
      <span>{{ room.online }}{{ room.capacity ? `/${room.capacity}` : '' }}</span>
    </div>
    <div v-if="demo" class="status-item">
      <span class="status-strong">演示数据</span>
      <span>不会连接真实服务器</span>
    </div>

    <div class="status-spacer"></div>

    <div class="status-hint"><span class="status-kbd">SPACE</span>短按静音 · 长按暂停房间</div>
    <div class="status-hint"><span class="status-kbd">长按</span>暂停房间</div>
    <div class="status-hint"><span class="status-kbd">CTRL K</span>搜索</div>
    <div class="status-hint"><span class="status-kbd">CTRL →</span>切歌</div>
    <div class="status-hint">{{ room.server }} · {{ room.mode }}</div>
  </footer>
</template>

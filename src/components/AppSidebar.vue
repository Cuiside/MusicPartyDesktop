<script setup>
/**
 * 侧边菜单（新 IA）。
 *
 * 结构固定为「房间 · ROOM」→「当前页」（可选）→「快捷 · QUICK」（可选）：
 * - 房间组包含房间卡片 + 房间信息/成员列表/即时聊天（都绑定右侧检查器）；
 * - 当前页组只接收**已绑定真实动作**的条目（筛选/检查器分区），没有就不渲染整组；
 * - 快捷组 ≤3 条，且不与 NavRail / 标题栏 / 账户菜单重复；
 * - 条目可带 `note: true`（只读说明，不可点击）或 `disabled` + `tooltip`；
 * - 未实现的条目不要传进来（见 docs/SIDEBAR_REDESIGN.md 的硬规则）。
 *
 * 组件只负责渲染并把 `select(id)` 交给 App，由 `handleSidebarSelect` 执行真实动作。
 */
import { Plus } from 'lucide-vue-next'

defineProps({
  room: { type: Object, default: null },
  groups: { type: Array, default: () => [] },
  /** @type {{ id: string, label: string, title?: string } | null} */
  create: { type: Object, default: null }
})
const emit = defineEmits(['select'])

const roomCode = (room) => {
  const code = room && room.code
  if (!code || code === '—' || code === '-') return ''
  return `ROOM ${code}`
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-scroll">
      <div
        v-for="group in groups"
        :key="group.title"
        class="side-group"
        :class="group.tone ? `tone-${group.tone}` : ''"
      >
        <div class="side-title">
          <span>{{ group.title }}</span>
          <span v-if="group.tag" class="side-tag">{{ group.tag }}</span>
        </div>

        <div v-if="group.roomCard && room" class="room-stub">
          <div class="room-stub-head">
            <span class="room-stub-name">{{ room.name }}</span>
            <span v-if="room.demo" class="room-stub-demo">演示</span>
            <span v-else-if="roomCode(room)" class="room-stub-code">{{ roomCode(room) }}</span>
          </div>
          <div class="room-stub-meta">
            <span>{{ room.server || room.mode }}</span>
            <span>·</span>
            <span>{{ room.mode }}</span>
          </div>
          <div class="room-stub-meta">
            <span>待播 {{ room.queueCount }} 首</span>
            <span>·</span>
            <span>{{ room.online }}{{ room.capacity ? `/${room.capacity}` : '' }} 人在线</span>
          </div>
        </div>

        <template v-for="item in group.items" :key="item.id">
          <div v-if="item.note" class="side-note">{{ item.label }}</div>
          <button
            v-else
            class="side-item"
            :class="{ active: item.active }"
            :disabled="item.disabled"
            :title="item.tooltip || item.label"
            @click="!item.disabled && emit('select', item.id)"
          >
            <component
              :is="item.icon"
              v-if="item.icon"
              class="side-icon"
              :size="15"
              :stroke-width="1.7"
            />
            <span class="side-label">{{ item.label }}<em v-if="item.subtitle" class="side-subtitle">{{ item.subtitle }}</em></span>
            <span v-if="item.count != null" class="side-count side-count-stack" :class="{ 'side-unread': item.unread }"><span>{{ item.count }}</span><small v-if="item.requestedBy" :title="item.requestedBy">{{ item.requestedBy }}</small></span>
            <span v-if="item.disabled && item.tooltip" class="side-count">—</span>
          </button>
        </template>
      </div>
    </div>

    <div v-if="create && create.label" class="sidebar-foot">
      <button class="side-create" :title="create.title || create.label" @click="emit('select', create.id)">
        <Plus :size="14" :stroke-width="1.9" />
        {{ create.label }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.side-count-stack { display:flex; flex-direction:column; align-items:flex-end; min-width:0; max-width:72px; gap:3px; }
.side-unread { min-width:20px; height:20px; padding:0 5px; border-radius:10px; align-items:center; justify-content:center; background:#d62f4d; color:#fff !important; font-weight:700; }
.side-count-stack small { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:400; }
</style>

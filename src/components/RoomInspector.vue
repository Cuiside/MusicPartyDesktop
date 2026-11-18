<script setup>
/**
 * 房间检查器（真实动作版）。
 *
 * 修复 P1-8：原来的「分享房间链接 / 生成直播流链接 / 锁定房间 / 复制房间号 / 更多 / 成员全部」
 * 六个按钮全部没有绑定。现在只保留真实能力：
 * - 复制服务器地址（本地剪贴板，真实可用；服务端没有邀请链接/房间码概念）；
 * - 查看队列（切换主视图）；
 * - 关闭检查器、切换 房间/成员/活动 分区（由侧栏「房间 · ROOM」组与内部分区 tab 驱动）。
 * 管理员能力（锁定/清空/直播流开关）统一在管理终端（AdminView）里做。
 */
import { computed } from 'vue'
import { MessageSquare, Copy, Headphones, Info, ListMusic, X } from 'lucide-vue-next'
import InstantChat from './InstantChat.vue'

const props = defineProps({
  room: { type: Object, required: true },
  members: { type: Array, default: () => [] },
  activity: { type: Array, default: () => [] },
  messages: { type: Array, default: () => [] },
  sendMessage: { type: Function, required: true },
  /** 'all' 显示全部；其余只显示对应分区（侧栏「房间信息/成员列表/即时聊天」）。 */
  section: { type: String, default: 'all' }
})
const emit = defineEmits(['close', 'action', 'section', 'send', 'add', 'find'])

const tabs = [
  { id: 'info', label: '房间', icon: Info },
  { id: 'members', label: '成员', icon: Headphones },
  { id: 'activity', label: '聊天', icon: MessageSquare }
]

const showInfo = computed(() => props.section === 'all' || props.section === 'info')
const showMembers = computed(() => props.section === 'all' || props.section === 'members')
const showActivity = computed(() => props.section === 'activity')
const roomCode = computed(() => {
  const code = props.room && props.room.code
  if (!code || code === '—' || code === '-') return ''
  return `ROOM ${code}`
})
</script>

<template>
  <aside class="inspector room-inspector">
    <div class="inspector-head">
      <span class="inspector-title">房间检查器 · INSPECTOR</span>
      <div class="inspector-head-actions">
        <div class="insp-tabs" role="tablist" aria-label="检查器分区">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            class="insp-tab"
            :class="{ on: section === tab.id }"
            role="tab"
            :aria-selected="section === tab.id"
            :title="`只看${tab.label}`"
            @click="emit('section', tab.id)"
          >
            <component :is="tab.icon" :size="12" :stroke-width="1.8" />
            {{ tab.label }}
          </button>
        </div>
        <button class="icon-chip" title="关闭检查器" @click="emit('close')">
          <X :size="14" />
        </button>
      </div>
    </div>

    <div class="inspector-body">
      <section v-if="showInfo" class="insp-section reveal reveal-1">
        <div class="room-card">
          <div class="room-card-top">
            <div>
              <div class="room-name">{{ room.name }}</div>
              <div class="room-code">
                {{ roomCode }}<span v-if="roomCode"> · </span>{{ room.locked ? '已锁定' : '开放中' }}
              </div>
            </div>
          </div>
          <div class="room-stats">
            <div class="room-stat">
              <span class="room-stat-val">{{ room.online }}</span>
              <span class="room-stat-key">在线</span>
            </div>
            <div class="room-stat">
              <span class="room-stat-val">{{ room.queueCount }}</span>
              <span class="room-stat-key">待播</span>
            </div>
            <div class="room-stat">
              <span class="room-stat-val"
                >{{ room.latency }}<span style="font-size: 10px">ms</span></span
              >
              <span class="room-stat-key">延迟</span>
            </div>
          </div>
          <div class="kv">
            <span class="kv-k">服务器</span><span class="kv-v">{{ room.server || '—' }}</span>
          </div>
          <div class="kv">
            <span class="kv-k">连接</span><span class="kv-v">{{ room.mode }}</span>
          </div>
        </div>
      </section>

      <section v-if="showMembers" class="insp-section reveal reveal-2">
        <div class="insp-title">
          <span>成员 · MEMBERS</span>
          <span class="insp-count">{{ members.length }}</span>
        </div>
        <div v-for="m in members" :key="m.name" class="member-row">
          <span class="member-avatar" :class="{ alt: !m.you }">{{ m.name.slice(0, 1) }}</span>
          <span class="member-name">
            {{ m.name }}<span v-if="m.you" style="opacity: 0.35"> · 我</span>
          </span>
          <span v-if="m.role" class="member-role">{{ m.role }}</span>
          <span v-if="m.status" class="member-status">{{ m.status }}</span>
        </div>
        <div v-if="!members.length" class="empty-text" style="max-width: none">暂无成员数据</div>
      </section>

      <InstantChat v-if="showActivity" :messages="messages" :send-message="sendMessage" @add="emit('add', $event)" @find="emit('find', $event)" />

      <section v-if="!showActivity" class="insp-section reveal reveal-4">
        <div class="insp-title"><span>操作 · ACTIONS</span></div>
        <div class="insp-actions">
          <button class="btn-ghost" type="button" @click="emit('action', 'copy-server')">
            <Copy :size="13" :stroke-width="1.8" />
            复制服务器地址
          </button>
          <button class="btn-ghost" type="button" @click="emit('action', 'open-queue')">
            <ListMusic :size="13" :stroke-width="1.8" />
            查看播放队列
          </button>
        </div>
        <div class="empty-text" style="max-width: none; padding-top: 6px">
          房间锁定、密码与直播流开关属于管理员能力，请在「管理员认证 → 管理终端」中操作。
        </div>
      </section>
    </div>
  </aside>
</template>

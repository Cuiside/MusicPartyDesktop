<script setup>
import { Download, Settings2, ShieldCheck } from 'lucide-vue-next'

const emit = defineEmits(['open-settings'])

const logs = [
  { time: '00:52', text: '阿伟 通过管理员密码登录', kind: 'admin' },
  { time: '00:50', text: '你 置顶了《测试音轨 04》', kind: 'action' },
  { time: '00:47', text: '房间在线人数 6 / 12', kind: 'info' },
  { time: '00:46', text: '直播流 token 已刷新', kind: 'info' },
  { time: '00:44', text: '/vote skip 未通过（1 / 6）', kind: 'vote' },
  { time: '00:41', text: '阿伟 点了《测试音轨 01》', kind: 'action' },
  { time: '00:38', text: 'Echo 加入房间', kind: 'info' },
  { time: '00:36', text: '后端服务健康检查通过', kind: 'info' },
  { time: '00:31', text: '清空队列（你）', kind: 'admin' },
  { time: '00:28', text: '私人电台已关闭', kind: 'info' }
]
</script>

<template>
  <aside class="inspector">
    <div class="inspector-head">
      <span class="inspector-title">系统检查器 · CONSOLE</span>
      <button class="icon-chip" title="设置"><Settings2 :size="14" /></button>
    </div>

    <div class="inspector-body">
      <section class="insp-section reveal reveal-1">
        <div class="room-card">
          <div class="room-card-top">
            <div>
              <div class="room-name">{{ '管理员控制台' }}</div>
              <div class="room-code">ROLE · ADMIN · 已认证</div>
            </div>
            <ShieldCheck :size="18" :stroke-width="1.6" />
          </div>
          <div class="room-stats">
            <div class="room-stat">
              <span class="room-stat-val">4h</span>
              <span class="room-stat-key">运行</span>
            </div>
            <div class="room-stat">
              <span class="room-stat-val">12</span>
              <span class="room-stat-key">操作</span>
            </div>
            <div class="room-stat">
              <span class="room-stat-val">0</span>
              <span class="room-stat-key">错误</span>
            </div>
          </div>
        </div>
      </section>

      <section class="insp-section reveal reveal-2">
        <div class="insp-title"><span>操作日志 · LOGS</span><button class="text-btn">全部</button></div>
        <div v-for="(log, i) in logs" :key="i" class="activity-row">
          <span class="activity-time">{{ log.time }}</span>
          <span>{{ log.text }}</span>
        </div>
      </section>

      <section class="insp-section reveal reveal-3">
        <div class="insp-title"><span>操作 · ACTIONS</span></div>
        <div class="insp-actions">
          <button class="btn-ghost" @click="emit('open-settings')">
            <Settings2 :size="13" /> 打开设置
          </button>
          <button class="btn-ghost"><Download :size="13" /> 导出系统日志</button>
        </div>
      </section>
    </div>
  </aside>
</template>

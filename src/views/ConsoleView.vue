<script setup>
/**
 * 「控制台」= 演示模式预览（不是管理员面板）。
 *
 * AUDIT_HALLUCINATION P1-3/P1-4：原 ConsoleView 的房间锁/房间密码/系统重置/STATS/
 * 播放控制/私人电台/私人 DJ/直播流链接/48kHz 全部是本地 ref 或假 toast；真正接服务端的
 * 管理能力在 AdminView。这里只保留两类真实内容：
 *   1) 本地服务（launcher）资源探测与启停 —— 真实 IPC；
 *   2) 演示预览说明 —— 明确标注「演示」，并提供「管理员认证 / 管理终端」真实入口。
 *
 * 真实房间（live）不再渲染本组件：App.vue 将「控制台」入口改为打开 AdminView。
 */
import { computed, onMounted, ref } from 'vue'
import {
  FolderOpen,
  PlayCircle,
  Server,
  Settings,
  ShieldCheck,
  Square
} from 'lucide-vue-next'
import { pushToast } from '../core/toast'
import {
  launcher,
  getStatus,
  start,
  stop,
  restart,
  openDataDir,
  pickFile,
  describeServiceState
} from '../core/launcher-bridge.js'

const emit = defineEmits(['open-settings', 'open-admin'])

const choosing = ref('')
const javaService = computed(() => launcher.status.services.java || {})
const serviceState = computed(() => describeServiceState(launcher.status))
const resources = computed(() => serviceState.value.resources)
const running = computed(() => Boolean(launcher.status.running))
const ready = computed(() => Boolean(resources.value.ready))

const resourceRows = computed(() => [
  { key: 'java', name: 'Java 运行时', found: Boolean(resources.value.javaFound), path: resources.value.javaPath || '' },
  { key: 'jar', name: 'server.jar', found: Boolean(resources.value.jarFound), path: resources.value.jarPath || '' },
  { key: 'netease', name: '网易云 API（可选）', found: Boolean(resources.value.neteaseFound), path: resources.value.neteasePath || '' }
])

const serviceDesc = computed(() => {
  switch (serviceState.value.kind) {
    case 'running':
      return `本机房间服务运行中：${launcher.status.baseUrl || 'http://127.0.0.1:8080'}`
    case 'ready':
      return '已找到 Java 运行时与 server.jar，可以启动本机房间服务。'
    case 'misconfigured':
      return `已配置的路径找不到文件（${serviceState.value.missingText}），请重新选择或连接远程房间。`
    case 'partial':
      return `内置资源缺少 ${serviceState.value.missingLabels.join(' 与 ')}；连接远程房间即可使用全部在线功能。`
    case 'unsupported':
      return '当前环境不支持本地服务管理（浏览器预览）；请使用桌面客户端。'
    default:
      return '当前版本不包含本地服务资源（Java 运行时 / server.jar），这属于公共版的正常状态；连接远程房间即可使用全部在线功能。'
  }
})

const startDisabled = computed(() => (!running.value && !ready.value) || Boolean(launcher.busy))
const startTitle = computed(() => {
  if (running.value) return '停止本地服务'
  if (ready.value) return '启动本地服务'
  return `${serviceState.value.missingText || '本地服务资源缺失'}，无法启动；可连接远程房间`
})

const toggleServices = async () => {
  if (launcher.busy) return
  if (!running.value && !ready.value) {
    pushToast(`${serviceState.value.missingText || '本地服务资源缺失'}，无法启动`, 'warn')
    return
  }
  const wasRunning = running.value
  const ok = wasRunning ? await stop() : await start()
  pushToast(ok ? (wasRunning ? '本地服务已停止' : '本地服务已启动') : `操作失败：${launcher.error || '未知错误'}`)
  await getStatus()
}

const restartServices = async () => {
  if (launcher.busy || !running.value) return
  const ok = await restart()
  pushToast(ok ? '本地服务已重启' : `重启失败：${launcher.error || '未知错误'}`)
  await getStatus()
}

const openUserData = async () => {
  const ok = await openDataDir()
  if (!ok) pushToast(launcher.error || '打开数据目录失败')
}

const chooseResource = async (kind) => {
  if (choosing.value || launcher.busy) return
  choosing.value = kind
  try {
    const picked = await pickFile(kind)
    if (picked.canceled) return
    if (!picked.ok) {
      pushToast(`无法选择文件：${picked.error || '未知错误'}`)
      return
    }
    pushToast(kind === 'java' ? '已选择 Java（请在设置中确认保存）' : '已选择 server.jar（请在设置中确认保存）')
    emit('open-settings')
  } finally {
    choosing.value = ''
  }
}

onMounted(() => {
  void getStatus()
})
</script>

<template>
  <div class="workspace console-demo">
    <div class="workspace-inner">
      <section class="console-demo-banner">
        <div class="console-demo-banner-head">
          <span class="label">控制台 · CONSOLE（演示预览）</span>
          <span class="status-pill warn">演示模式 · 只读预览</span>
        </div>
        <h2 class="console-demo-title">真实管理能力在「管理终端」</h2>
        <p class="console-demo-text">
          当前是演示模式，本页只展示可以本地验证的「本地服务」状态，不会修改任何真实房间或服务器。
          房间密码、锁定、播放控制、直播流开关、音源 Cookie 与系统参数需要管理员认证后在管理终端操作。
        </p>
        <div class="console-demo-actions">
          <button class="btn-primary" type="button" @click="emit('open-admin')">
            <ShieldCheck :size="14" :stroke-width="2" />
            管理员认证 · 打开管理终端
          </button>
          <button class="btn-ghost" type="button" @click="emit('open-settings')">
            <Settings :size="13" :stroke-width="1.8" />
            打开设置
          </button>
        </div>
      </section>

      <section class="panel reveal reveal-2">
        <div class="panel-head">
          <span class="label">本地服务 · LOCAL SERVICE</span>
          <span class="status-pill" :class="{ ok: running }">{{ serviceState.label }}</span>
        </div>
        <div class="panel-body">
          <p class="console-demo-text" style="margin-bottom: 10px">
            {{ serviceDesc }}
          </p>
          <div class="console-service-grid">
            <div v-for="row in resourceRows" :key="row.key" class="console-service-row">
              <span class="service-dot" :class="{ idle: !row.found }"></span>
              <span class="console-service-name">{{ row.name }}</span>
              <span class="status-pill" :class="{ ok: row.found }">{{ row.found ? '已找到' : '缺失' }}</span>
              <span class="console-service-path" :title="row.path">{{ row.path || '—' }}</span>
            </div>
          </div>
          <div class="console-demo-actions" style="margin-top: 12px">
            <button class="btn-ghost" type="button" :disabled="startDisabled" :title="startTitle" @click="toggleServices">
              <component :is="running ? Square : PlayCircle" :size="13" :stroke-width="1.8" />
              {{ running ? '停止本地服务' : '启动本地服务' }}
            </button>
            <button class="btn-ghost" type="button" :disabled="launcher.busy || !running" @click="restartServices">重启</button>
            <button class="btn-ghost" type="button" :disabled="choosing === 'jar'" @click="chooseResource('jar')">选择 server.jar</button>
            <button class="btn-ghost" type="button" :disabled="choosing === 'java'" @click="chooseResource('java')">选择 Java</button>
            <button class="btn-ghost" type="button" @click="openUserData">
              <FolderOpen :size="13" :stroke-width="1.8" /> 数据目录
            </button>
          </div>
          <p v-if="!running && !ready" class="console-demo-hint">
            公共版安装包不包含 Java 运行时 / server.jar，这属于正常状态；连接远程房间即可使用全部在线功能。
          </p>
          <p v-else-if="javaService.pid" class="console-demo-hint">PID {{ javaService.pid }} · {{ launcher.status.baseUrl || '' }}</p>
        </div>
      </section>

      <section class="panel reveal reveal-3">
        <div class="panel-head">
          <span class="label">去哪里做真实管理 · REAL ADMIN</span>
          <Server :size="13" :stroke-width="1.8" />
        </div>
        <div class="panel-body">
          <div class="console-demo-list">
            <div class="console-demo-list-row"><span>房间控制（锁定 / 密码 / 人数 / 清空）</span><span>管理终端</span></div>
            <div class="console-demo-list-row"><span>播放与队列（暂停 / 切歌 / 随机 / 私人电台）</span><span>管理终端</span></div>
            <div class="console-demo-list-row"><span>音源账号（网易云 Cookie / B 站 SESSDATA）</span><span>管理终端</span></div>
            <div class="console-demo-list-row"><span>直播流开关（token 由聊天 //stream 私聊发放）</span><span>管理终端</span></div>
            <div class="console-demo-list-row"><span>搜索 / 点歌 / 聊天 / 队列操作</span><span>左侧导航可用（演示数据）</span></div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * Admin console — the real (non-demo) configuration center for the desktop client.
 *
 * Full-page overlay shown after `AdminAuthDialog` verifies the admin password. Every
 * control calls the real backend through `src/core/live/admin.js` (HTTP bridge →
 * `http://<server>/api/admin/*` with `X-Admin-Password`) and reports the server's
 * message through the shared toast stack.
 *
 * Live state is read from `live.config` (server `PlayerState.config` broadcast):
 * `neteaseCookieConfigured`, platform switches, vote-skip settings and `privateDj`.
 * Fields the server does NOT broadcast to the desktop client are never faked:
 * - Bilibili credential state is not broadcast → label says "服务端未广播状态";
 * - individual lock types are not broadcast → explicit 锁定/解锁 buttons, plus the
 *   aggregate `live.locked` flag;
 * - stream state is not mapped → the switch only reflects actions taken in this session.
 *
 * Integrate from `App.vue` with:
 *   import AdminView from './views/AdminView.vue'
 *   import AdminAuthDialog from './components/AdminAuthDialog.vue'
 *   import { adminAuth } from './core/live/admin.js'
 *   // account menu "管理员认证" → adminAuthOpen = true
 *   // <AdminAuthDialog :open="adminAuthOpen" @verified="adminAuthOpen = false; adminOpen = true" @close="adminAuthOpen = false" />
 *   // <AdminView v-if="adminOpen && adminAuth.verified" @close="adminOpen = false" />
 * The root element is a fixed overlay below the titlebar, so App layout is untouched.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  AlertTriangle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Music2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Save,
  ShieldCheck,
  SkipForward,
  Sliders,
  Sparkles,
  Trash2,
  Unlock,
  Video,
  Wifi,
  WifiOff,
  X
} from 'lucide-vue-next'
import { live } from '../core/live/state'
import { pushToast } from '../core/toast'
import { activeBase } from '../core/live/session'
import {
  adminAuth,
  adminRequest,
  adminLogout,
  clearAdminData,
  playerAction,
  resetSystem,
  setLock,
  setPlatformCookie,
  setRoomPassword,
  setStream,
  updateAdminConfig,
  updatePrivateDj,
  verifyAdmin
} from '../core/live/admin'

const emit = defineEmits(['close', 'open-settings'])

/** 当前管理员会话绑定的服务器 base（D-08：认证按 base 绑定，不使用可变设置值）。 */
const serverBase = computed(() => live.sessionBase || adminAuth.authenticatedServerBase || activeBase())

/**
 * Escape closes the in-page confirmation first, then the whole console. The app's own
 * Escape handler only manages its dialogs, so this listener is scoped to the overlay.
 * @param {KeyboardEvent} event
 */
const onAdminKeydown = (event) => {
  if (event.key !== 'Escape') return
  if (confirmState.value) {
    confirmState.value = null
    return
  }
  emit('close')
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Per-action loading flags, e.g. `pending['cookie-netease']`. */
const pending = reactive({})
const isPending = (key) => Boolean(pending[key])

/**
 * Run one admin action with a loading flag + toast on success/failure.
 * @param {string} key unique loading key
 * @param {() => Promise<Record<string, any>>} action
 * @returns {Promise<boolean>}
 */
const runAction = async (key, action) => {
  if (pending[key]) return false
  pending[key] = true
  try {
    const payload = await action()
    pushToast(payload?.message || '操作已完成')
    return true
  } catch (error) {
    pushToast(String(error?.message || error) || '操作失败', 'warn')
    return false
  } finally {
    pending[key] = false
  }
}

const hasConfigState = computed(() => Boolean(live.config && Object.keys(live.config).length > 0))
const credentialSources = ref([])
const loadCredentialSources = async () => {
  if (!adminAuth.verified) return
  try {
    const result = await adminRequest('GET', '/api/admin/sources')
    credentialSources.value = Array.isArray(result?.sources) ? result.sources : []
  } catch { credentialSources.value = [] }
}
watch(() => [adminAuth.verified, serverBase.value], () => { credentialSources.value = []; void loadCredentialSources() }, { immediate: true })
const connectionLabel = computed(() =>
  live.joined ? `已加入 · ${live.server || '房间'}` : '未加入房间'
)
const neteaseConfigured = computed(() =>
  credentialSources.value.find(item => item.id === 'netease')?.credential?.configured ?? null
)
const neteaseStatus = computed(() => {
  if (neteaseConfigured.value === true) return { text: '已配置', kind: 'ok' }
  if (neteaseConfigured.value === false) return { text: '未配置', kind: 'warn' }
  return { text: '未知 · 未加入房间', kind: '' }
})

/* ------------------------------------------------------------------ */
/* 01 platform credentials                                             */
/* ------------------------------------------------------------------ */

const credentialsRef = ref(null)
const credentialsPulse = ref(false)
let pulseTimer = 0

const focusCredentials = () => {
  credentialsRef.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  credentialsPulse.value = true
  clearTimeout(pulseTimer)
  pulseTimer = setTimeout(() => {
    credentialsPulse.value = false
  }, 1600)
}

const cookieValue = reactive({ netease: '', bilibili: '', qqmusic: '' })
const cookieVisible = reactive({ netease: false, bilibili: false, qqmusic: false })

const submitCookie = async (platform) => {
  const value = String(cookieValue[platform] || '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
  if (!value) {
    pushToast(
      '请粘贴该音源的 Cookie',
      'warn'
    )
    return
  }
  if (platform === 'netease' && !/MUSIC_U\s*=/i.test(value)) {
    pushToast('未检测到 MUSIC_U=，请确认复制的是 music.163.com 的完整 Cookie', 'warn')
    return
  }
  if (platform === 'bilibili' && !/SESSDATA\s*=/i.test(value)) {
    pushToast('未检测到 SESSDATA=，请从 bilibili.com 复制完整 Cookie（不要只粘贴值）', 'warn')
    return
  }
  const ok = await runAction(`cookie-${platform}`, () => setPlatformCookie(platform, value))
  if (!ok) return
  cookieValue[platform] = ''
  cookieVisible[platform] = false
  await loadCredentialSources()
}

/* ------------------------------------------------------------------ */
/* 02 sources & system parameters                                      */
/* ------------------------------------------------------------------ */

/**
 * Editable parameters. `key` is the broadcast (`PlayerState.config`) field,
 * `api` is the field name expected by the current `AdminConfigUpdateRequest`.
 */
const PARAM_FIELDS = [
  { key: 'maxQueueSize', api: 'maxQueueSize', label: '队列最大长度', unit: '首', min: 1, max: 100000, step: 1 },
  { key: 'maxHistorySize', api: 'maxHistorySize', label: '历史记录容量', unit: '首', min: 0, max: 100000, step: 1 },
  { key: 'maxUserSongs', api: 'maxUserSongs', label: '用户点歌上限', unit: '首', min: 0, max: 10000, step: 1 },
  { key: 'maxPlaylistImportSize', api: 'maxPlaylistImportSize', label: '歌单导入上限', unit: '首', min: 1, max: 10000, step: 1 },
  { key: 'maxChatHistorySize', api: 'maxChatHistorySize', label: '聊天记录容量', unit: '条', min: 0, max: 100000, step: 1 },
  { key: 'minChatIntervalMs', api: 'minChatIntervalMs', label: '发言冷却', unit: 'ms', min: 0, max: 600000, step: 100 },
  { key: 'maxChatMessageLength', api: 'maxChatMessageLength', label: '消息长度上限', unit: '字', min: 1, max: 2000, step: 1 },
  { key: 'bilibiliMaxDurationMinutes', api: 'bilibiliMaxDurationMinutes', label: 'B 站视频时长上限', unit: '分钟', min: 0, max: 1440, step: 1 },
  { key: 'voteSkipThreshold', api: 'voteSkipThreshold', label: '投票跳过比例', unit: '0.1–1.0', min: 0.1, max: 1, step: 0.1 },
  { key: 'voteSkipWaitTime', api: 'voteSkipWaitTime', label: '投票等待时间', unit: '秒', min: 0, max: 600, step: 1 }
]

const paramForm = reactive({})
const paramBaseline = reactive({})

const seedParams = () => {
  for (const field of PARAM_FIELDS) {
    const current = live.config ? live.config[field.key] : undefined
    paramForm[field.key] = current == null ? '' : String(current)
    paramBaseline[field.key] = paramForm[field.key]
  }
  paramForm.voteSkipEnabled = Boolean(live.config && live.config.voteSkipEnabled)
  paramBaseline.voteSkipEnabled = paramForm.voteSkipEnabled
}
seedParams()

/**
 * Build the minimal patch (only changed fields) for `POST /api/admin/config/update`.
 * @returns {{ patch: Record<string, number | boolean> } | { error: string }}
 */
const buildParamPatch = () => {
  const patch = {}
  for (const field of PARAM_FIELDS) {
    const raw = String(paramForm[field.key] ?? '').trim()
    if (raw === '') continue
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return { error: `${field.label}需要填写数字` }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return { error: `${field.label}需要填写数字` }
    const value = field.step < 1 ? Math.round(parsed * 100) / 100 : Math.round(parsed)
    if (value < field.min || value > field.max) {
      return { error: `${field.label}需在 ${field.min}–${field.max} 之间` }
    }
    if (String(value) === String(paramBaseline[field.key])) continue
    patch[field.api] = value
  }
  if (Boolean(paramForm.voteSkipEnabled) !== Boolean(paramBaseline.voteSkipEnabled)) {
    patch.voteSkipEnabled = Boolean(paramForm.voteSkipEnabled)
  }
  return { patch }
}

const paramError = computed(() => {
  const result = buildParamPatch()
  return result.error || ''
})
const paramDirtyCount = computed(() => {
  const result = buildParamPatch()
  return result.error ? 0 : Object.keys(result.patch).length
})

const saveParams = async () => {
  const result = buildParamPatch()
  if (result.error) {
    pushToast(result.error, 'warn')
    return
  }
  const patch = result.patch
  const keys = Object.keys(patch)
  if (!keys.length) {
    pushToast('没有需要保存的改动', 'warn')
    return
  }
  const ok = await runAction('params-save', () => updateAdminConfig(patch))
  if (!ok) return
  // Keep the UI in sync with what was just accepted; the server broadcast will
  // reseed the baseline again (watch below) once the new PlayerState arrives.
  for (const field of PARAM_FIELDS) {
    if (patch[field.api] !== undefined) paramBaseline[field.key] = String(patch[field.api])
  }
  if (patch.voteSkipEnabled !== undefined) paramBaseline.voteSkipEnabled = patch.voteSkipEnabled
}

// Server broadcasts a fresh config after every admin config change: adoption is safe
// only while the operator has no unsaved edits.
watch(
  () => live.config,
  () => {
    if (paramDirtyCount.value === 0) seedParams()
  },
  { deep: true }
)

const platformEnabled = (kind) =>
  hasConfigState.value ? Boolean(live.config && live.config[`${kind}Enabled`]) : false

const togglePlatform = async (kind) => {
  if (!hasConfigState.value) {
    pushToast('尚未收到服务端实时状态：先加入房间再切换音源开关', 'warn')
    return
  }
  const next = !platformEnabled(kind)
  const patch = live.config.sources ? { sources: { [kind]: { enabled: next } } } : { [`${kind}Enabled`]: next }
  await runAction(`platform-${kind}`, () => updateAdminConfig(patch))
}

/* ------------------------------------------------------------------ */
/* 03 room environment / maintenance                                   */
/* ------------------------------------------------------------------ */

const roomPassword = ref('')
const saveRoomPassword = async () => {
  const ok = await runAction('room-password', () => setRoomPassword(roomPassword.value))
  if (ok) roomPassword.value = ''
}

/**
 * Stream state is NOT mapped by `transport.js`/`live` (the desktop client only keeps
 * `live.config`, `live.locked`, playback and queue). The switch therefore records the
 * result of operations issued in this session instead of pretending to know the
 * server state; the call itself is real.
 */
const streamState = reactive({ known: false, enabled: false })
const streamDescription = computed(() => {
  if (isPending('stream')) return '正在下发直播流开关…'
  if (!streamState.known) return '本机未记录状态 · 点击会真实调用服务端接口'
  return streamState.enabled ? '已开启 · 状态来自本机操作记录' : '已关闭 · 状态来自本机操作记录'
})
const toggleStream = async () => {
  const next = !(streamState.known && streamState.enabled)
  const ok = await runAction('stream', () => setStream(next))
  if (!ok) return
  streamState.known = true
  streamState.enabled = next
}

const CLEAR_ACTIONS = [
  {
    target: 'QUEUE',
    label: '清理播放队列',
    title: '清空播放队列？',
    text: '将移除全部待播歌曲（保留当前播放），操作会同步到房间内所有人。',
    confirmLabel: '清空队列'
  },
  {
    target: 'OFFLINE',
    label: '清理离线成员点歌',
    title: '清理离线成员的点歌？',
    text: '将移除已离线成员点播的歌曲，其余队列保持不变。',
    confirmLabel: '清理离线点歌'
  },
  {
    target: 'CHAT',
    label: '清空聊天记录',
    title: '清空聊天记录？',
    text: '将清空服务端聊天历史并通知所有成员，不可恢复。',
    confirmLabel: '清空聊天'
  }
]

/**
 * In-page second-step confirmation (no browser `confirm()`): dangerous buttons open
 * this state, the confirm button executes the action.
 * @type {import('vue').Ref<null | { title: string, text: string, confirmLabel: string, run: () => Promise<unknown> }>}
 */
const confirmState = ref(null)
const askClear = (action) => {
  confirmState.value = {
    title: action.title,
    text: action.text,
    confirmLabel: action.confirmLabel,
    run: () => runAction(`clear-${action.target}`, () => clearAdminData(action.target))
  }
}
const askReset = () => {
  confirmState.value = {
    title: '全系统重置？',
    text: '将重置播放器、队列与核心状态并广播给所有成员，当前房间会立即受影响，且不可撤销。',
    confirmLabel: '确认重置系统',
    run: () => runAction('system-reset', () => resetSystem())
  }
}
const cancelConfirm = () => {
  confirmState.value = null
}
const runConfirm = async () => {
  const current = confirmState.value
  confirmState.value = null
  if (current) await current.run()
}

/* ------------------------------------------------------------------ */
/* 04 playback & locks                                                 */
/* ------------------------------------------------------------------ */

const playbackSummary = computed(() => {
  if (!live.joined) return '未加入房间 · 无法读取播放状态（指令仍会发送到服务器）'
  if (!live.nowPlaying) return '当前没有正在播放的歌曲'
  return `${live.nowPlaying.title} · ${live.playing ? '播放中' : '已暂停'}`
})

const runPlayer = (action) => runAction(`player-${action}`, () => playerAction(action))

const LOCK_ROWS = [
  { type: 'PAUSE', label: '暂停控制' },
  { type: 'SKIP', label: '切歌控制' },
  { type: 'SHUFFLE', label: '播放模式' },
  { type: 'ALL', label: '全频道' }
]
const runLock = (type, locked) =>
  runAction(`lock-${type}-${locked ? 'on' : 'off'}`, () => setLock(type, locked))

const lockSummary = computed(() => {
  if (!hasConfigState.value) return { text: '锁定状态未知', kind: '' }
  return live.locked ? { text: '存在锁定', kind: 'warn' } : { text: '无锁定', kind: 'ok' }
})

/* ------------------------------------------------------------------ */
/* 05 private radio / private DJ                                       */
/* ------------------------------------------------------------------ */

const DJ_MODES = [
  { value: 'OFF', label: '关闭' },
  { value: 'FM', label: '私人 FM' },
  { value: 'DJ', label: '私人 DJ' }
]
const DJ_SWITCHES = [
  { field: 'fillBlankEnabled', label: '填充空白', hint: '队列没有可用歌曲时自动播放 FM / DJ' },
  { field: 'joinQueueEnabled', label: '加入队列', hint: '仅随机模式生效，固定使用私人 FM' },
  { field: 'custodyEnabled', label: '播放托管', hint: '无视队列，仅播放 FM / DJ' }
]

const djConfig = computed(
  () =>
    live.config?.privateDj || {
      mode: 'OFF',
      fillBlankEnabled: false,
      joinQueueEnabled: false,
      custodyEnabled: false
    }
)
const djMode = computed(() => (hasConfigState.value ? String(djConfig.value.mode || 'OFF') : null))
const djCookieGate = computed(() => {
  if (neteaseConfigured.value === true) return { text: '网易云 Cookie 已配置', kind: 'ok' }
  if (neteaseConfigured.value === false) return { text: '需先配置网易云 Cookie', kind: 'warn' }
  return { text: 'Cookie 状态未知', kind: '' }
})

const setDjMode = async (mode) => {
  const target = djMode.value === mode ? 'OFF' : mode
  if (target !== 'OFF' && neteaseConfigured.value === false) {
    pushToast('需先配置网易云 Cookie 才能开启私人电台', 'warn')
    focusCredentials()
    return
  }
  await runAction(`dj-mode-${target}`, () => updatePrivateDj({ mode: target }))
}

const toggleDjSwitch = async (field) => {
  if (!hasConfigState.value) {
    pushToast('尚未收到服务端实时状态：先加入房间再调整私人电台开关', 'warn')
    return
  }
  if (djMode.value === 'OFF') {
    pushToast('先开启私人 FM 或私人 DJ，再调整功能开关', 'warn')
    return
  }
  const next = !Boolean(djConfig.value?.[field])
  await runAction(`dj-${field}`, () => updatePrivateDj({ [field]: next }))
}

/* ------------------------------------------------------------------ */
/* auth / gate / logout                                                */
/* ------------------------------------------------------------------ */

const gatePassword = ref('')
const gateVisible = ref(false)
const gateError = ref('')
const gateErrorText = computed(() => gateError.value || adminAuth.error)

const submitGate = async () => {
  gateError.value = ''
  if (!gatePassword.value.trim()) {
    // D-09：空 / 纯空白密码本地先拒绝，不再把空密码发给服务端。
    gateError.value = '请输入管理员密码（不能为空或纯空白）'
    return
  }
  const ok = await verifyAdmin(gatePassword.value)
  if (!ok) {
    gateError.value = adminAuth.error || '认证失败，请重试'
    return
  }
  gatePassword.value = ''
  pushToast('管理员认证成功')
}

const logout = () => {
  adminLogout()
  pushToast('已退出管理员认证')
}

onBeforeUnmount(() => {
  clearTimeout(pulseTimer)
  window.removeEventListener('keydown', onAdminKeydown)
})

onMounted(() => {
  window.addEventListener('keydown', onAdminKeydown)
})
</script>

<template>
  <!-- Defensive login gate: the app normally opens this view only after verification. -->
  <div v-if="!adminAuth.verified" class="admin-page">
    <div class="admin-gate">
      <div class="admin-gate-card">
        <div class="admin-gate-bar"></div>
        <div class="admin-gate-inner">
          <span class="admin-gate-kicker">ADMIN AUTHENTICATION · 管理员认证</span>
          <h1 class="admin-gate-title"><ShieldCheck :size="22" :stroke-width="2" /> 管理终端需要认证</h1>
          <p class="admin-gate-desc">
            管理终端会直接修改服务端配置、平台凭据与房间状态。请输入服务端配置的管理员密码；
            密码只保存在本机内存，退出或刷新即清除。
          </p>
          <form class="admin-gate-form" novalidate @submit.prevent="submitGate">
            <label class="admin-param-label" for="admin-gate-password">
              <span><KeyRound :size="12" /> 管理员密码</span>
            </label>
            <div class="admin-secret-row">
              <input
                id="admin-gate-password"
                v-model="gatePassword"
                class="text-field"
                :type="gateVisible ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="输入管理员密码"
                :disabled="adminAuth.verifying"
              />
              <button
                type="button"
                class="admin-mini"
                :title="gateVisible ? '隐藏密码' : '显示密码'"
                @click="gateVisible = !gateVisible"
              >
                <component :is="gateVisible ? EyeOff : Eye" :size="12" />
                {{ gateVisible ? '隐藏' : '显示' }}
              </button>
            </div>
            <p v-if="gateErrorText" class="admin-error" role="alert">{{ gateErrorText }}</p>
            <div class="admin-gate-actions">
              <button type="button" class="btn-ghost" :disabled="adminAuth.verifying" @click="emit('close')">
                返回应用
              </button>
              <button type="submit" class="btn-primary" :disabled="adminAuth.verifying">
                <Loader2 v-if="adminAuth.verifying" class="admin-spin" :size="14" />
                {{ adminAuth.verifying ? '验证中…' : '验证并进入' }}
              </button>
            </div>
          </form>
          <p class="admin-gate-note">
            服务端地址 <b class="mono">{{ serverBase }}</b> · 密码在服务端
            <b class="mono">ADMIN_PASSWORD</b> / <b class="mono">application.yml</b> 中配置。
          </p>
          <p class="admin-gate-note">
            本机服务（127.0.0.1）的初始管理员密码由本地启动器保管：可在
            <button type="button" class="text-btn" @click="emit('open-settings')">设置 → 服务与连接 → 本机管理员密码</button>
            中查看或重新生成；远程服务器的管理员密码由服务器自身配置。
          </p>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="admin-page">
    <header class="admin-header">
      <div class="admin-header-main">
        <span class="admin-kicker">ADMIN CONSOLE · SYSTEM_CONTROL_INTERFACE</span>
        <div class="admin-title-row">
          <span class="admin-badge"><ShieldCheck :size="12" :stroke-width="2.2" /> 管理员</span>
          <h1 class="admin-title">管理终端</h1>
          <span class="admin-conn-chip" :class="{ ok: live.joined }">
            <component :is="live.joined ? Wifi : WifiOff" :size="11" />
            {{ connectionLabel }}
          </span>
        </div>
        <p class="admin-sub">
          真实后端配置 · 网易云 Cookie / B 站 SESSDATA / 系统参数 / 房间与播放控制 · 状态来自服务端实时广播
        </p>
      </div>
      <div class="admin-header-actions">
        <span class="admin-server mono" :title="serverBase">{{ serverBase }}</span>
        <button type="button" class="btn-ghost" @click="logout">
          <LogOut :size="13" /> 退出管理员
        </button>
        <button type="button" class="btn-primary" @click="emit('close')">
          <X :size="14" /> 返回应用
        </button>
      </div>
    </header>

    <div class="admin-scroll">
      <div v-if="!hasConfigState" class="admin-notice">
        <WifiOff :size="14" />
        <span>
          尚未收到服务端实时状态（未加入房间或正在重连）：依赖实时状态的开关会禁用，
          凭据、参数与操作类按钮仍可直接提交。加入房间后状态会自动同步。
        </span>
      </div>

      <div class="admin-grid">
        <!-- ============ left column ============ -->
        <div class="admin-col">
          <!-- 01 · 平台凭据 -->
          <section
            ref="credentialsRef"
            class="admin-panel"
            :class="{ pulse: credentialsPulse }"
          >
            <div class="admin-panel-head">
              <div class="admin-panel-title">
                <span class="admin-num">01</span>
                <span class="admin-label">平台凭据 · CREDENTIALS</span>
              </div>
              <span class="admin-head-note">由服务端保存</span>
            </div>
            <div class="admin-panel-body">
              <div class="admin-block">
                <div class="admin-field-head">
                  <span class="admin-row-name"><Music2 :size="13" /> 网易云音乐 COOKIE</span>
                  <span class="status-pill" :class="neteaseStatus.kind">{{ neteaseStatus.text }}</span>
                </div>
                <textarea
                  v-model="cookieValue.netease"
                  class="admin-textarea"
                  :class="{ masked: !cookieVisible.netease }"
                  rows="3"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="粘贴 music.163.com 的完整 Cookie：MUSIC_U=...; __csrf=...;"
                ></textarea>
                <p class="admin-hint">
                  浏览器 F12 → Network → 任一 music.163.com 请求 → 复制 Cookie 请求头。
                  必须包含 <b class="mono">MUSIC_U=...</b>。凭据只提交给后端，本页输入在提交后清空。
                </p>
                <div class="admin-actions">
                  <button
                    type="button"
                    class="admin-mini"
                    @click="cookieVisible.netease = !cookieVisible.netease"
                  >
                    <component :is="cookieVisible.netease ? EyeOff : Eye" :size="12" />
                    {{ cookieVisible.netease ? '隐藏' : '显示' }}
                  </button>
                  <button
                    type="button"
                    class="btn-primary small"
                    :disabled="isPending('cookie-netease')"
                    @click="submitCookie('netease')"
                  >
                    <Loader2 v-if="isPending('cookie-netease')" class="admin-spin" :size="13" />
                    <Save v-else :size="13" />
                    更新网易云 Cookie
                  </button>
                </div>
              </div>

              <div class="admin-block">
                <div class="admin-field-head">
                  <span class="admin-row-name"><Video :size="13" /> B 站 SESSDATA</span>
                  <span class="status-pill">服务端未广播状态</span>
                </div>
                <textarea
                  v-model="cookieValue.bilibili"
                  class="admin-textarea"
                  :class="{ masked: !cookieVisible.bilibili }"
                  rows="3"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="粘贴 bilibili.com 的完整 Cookie：SESSDATA=...; buvid3=...;"
                ></textarea>
                <p class="admin-hint">
                  从 bilibili.com 的 Cookie 复制完整字符串，至少包含
                  <b class="mono">SESSDATA=...</b>；建议连同 <b class="mono">buvid3</b> /
                  <b class="mono">buvid4</b> 一起粘贴以避免搜索风控。更新后请到搜索页验证 B 站结果。
                  服务端不向桌面端广播 B 站凭据状态，因此这里不显示「已配置」。
                </p>
                <div class="admin-actions">
                  <button
                    type="button"
                    class="admin-mini"
                    @click="cookieVisible.bilibili = !cookieVisible.bilibili"
                  >
                    <component :is="cookieVisible.bilibili ? EyeOff : Eye" :size="12" />
                    {{ cookieVisible.bilibili ? '隐藏' : '显示' }}
                  </button>
                  <button
                    type="button"
                    class="btn-primary small"
                    :disabled="isPending('cookie-bilibili')"
                    @click="submitCookie('bilibili')"
                  >
                    <Loader2 v-if="isPending('cookie-bilibili')" class="admin-spin" :size="13" />
                    <Save v-else :size="13" />
                    更新 B 站 Cookie
                  </button>
                </div>
              </div>
              <div class="admin-block" v-if="credentialSources.some(item => item.id === 'qqmusic')">
                <div class="admin-field-head"><span class="admin-row-name"><Music2 :size="13" /> QQ音乐 COOKIE</span>
                  <span class="status-pill">{{ credentialSources.find(item => item.id === 'qqmusic')?.credential?.configured ? '已配置' : '未配置' }}</span></div>
                <textarea v-model="cookieValue.qqmusic" class="admin-textarea" :class="{ masked: !cookieVisible.qqmusic }" rows="3" spellcheck="false" autocomplete="off" placeholder="粘贴 QQ 音乐 Cookie（包含 musicid 和 musickey）"></textarea>
                <p class="admin-hint">Cookie 只提交给当前服务端，提交后清空；音源可匿名使用时无需填写。</p>
                <div class="admin-actions"><button type="button" class="admin-mini" @click="cookieVisible.qqmusic = !cookieVisible.qqmusic">{{ cookieVisible.qqmusic ? '隐藏' : '显示' }}</button>
                  <button type="button" class="btn-primary small" :disabled="isPending('cookie-qqmusic')" @click="submitCookie('qqmusic')">更新 QQ 音乐 Cookie</button></div>
              </div>
            </div>
          </section>

          <!-- 02 · 音源与系统参数 -->
          <section class="admin-panel">
            <div class="admin-panel-head">
              <div class="admin-panel-title">
                <span class="admin-num">02</span>
                <span class="admin-label">音源与系统参数 · PARAMETERS</span>
              </div>
              <span class="admin-head-note">只提交改动字段</span>
            </div>
            <div class="admin-panel-body">
              <div class="admin-block">
                <span class="admin-block-title">音源开关 · SOURCES</span>
                <div class="admin-row">
                  <div class="admin-row-info">
                    <span class="admin-row-name"><Music2 :size="13" /> 网易云音乐</span>
                    <span class="admin-row-desc">关闭后网易云搜索与播放不可用；需服务端实时状态才能切换</span>
                  </div>
                  <button
                    type="button"
                    class="switch"
                    :class="{ on: platformEnabled('netease') }"
                    :disabled="!hasConfigState || isPending('platform-netease')"
                    :aria-label="platformEnabled('netease') ? '关闭网易云音乐' : '开启网易云音乐'"
                    @click="togglePlatform('netease')"
                  >
                    <i></i>
                  </button>
                </div>
                <div class="admin-row">
                  <div class="admin-row-info">
                    <span class="admin-row-name"><Video :size="13" /> Bilibili</span>
                    <span class="admin-row-desc">关闭后 B 站搜索与播放不可用；需服务端实时状态才能切换</span>
                  </div>
                  <button
                    type="button"
                    class="switch"
                    :class="{ on: platformEnabled('bilibili') }"
                    :disabled="!hasConfigState || isPending('platform-bilibili')"
                    :aria-label="platformEnabled('bilibili') ? '关闭 Bilibili' : '开启 Bilibili'"
                    @click="togglePlatform('bilibili')"
                  >
                    <i></i>
                  </button>
                </div>
                <div class="admin-row" v-if="live.config?.sources?.qqmusic">
                  <div class="admin-row-info"><span class="admin-row-name"><Music2 :size="13" /> QQ音乐</span><span class="admin-row-desc">需要可用的 QQ 音乐 API 服务</span></div>
                  <button type="button" class="switch" :class="{ on: platformEnabled('qqmusic') }" :disabled="isPending('platform-qqmusic')" aria-label="切换 QQ 音乐" @click="togglePlatform('qqmusic')"><i></i></button>
                </div>
              </div>

              <div class="admin-block">
                <span class="admin-block-title">数值参数 · PARAMETERS</span>
                <div class="admin-params">
                  <label v-for="field in PARAM_FIELDS" :key="field.key" class="admin-param">
                    <span class="admin-param-label">
                      <span>{{ field.label }}</span>
                      <b>{{ field.unit }}</b>
                    </span>
                    <input
                      v-model="paramForm[field.key]"
                      class="text-field"
                      type="number"
                      :step="field.step"
                      :min="field.min"
                      :max="field.max"
                      :placeholder="hasConfigState ? '未设置' : '未加入房间'"
                    />
                    <span class="admin-param-api mono">{{ field.api }}</span>
                  </label>
                </div>
                <div class="admin-row">
                  <div class="admin-row-info">
                    <span class="admin-row-name">投票切歌模式</span>
                    <span class="admin-row-desc">
                      开启后成员可投票跳过当前歌曲；比例与等待时间包含在上方参数中
                    </span>
                  </div>
                  <button
                    type="button"
                    class="switch"
                    :class="{ on: Boolean(paramForm.voteSkipEnabled) }"
                    aria-label="切换投票切歌模式"
                    @click="paramForm.voteSkipEnabled = !paramForm.voteSkipEnabled"
                  >
                    <i></i>
                  </button>
                </div>
                <div class="admin-save-row">
                  <span v-if="paramError" class="admin-error">{{ paramError }}</span>
                  <span v-else class="admin-hint">
                    {{
                      paramDirtyCount
                        ? `${paramDirtyCount} 项改动待保存`
                        : '没有改动 · 留空的参数不会被提交'
                    }}
                  </span>
                  <button
                    type="button"
                    class="btn-primary"
                    :disabled="paramDirtyCount === 0 || isPending('params-save')"
                    @click="saveParams"
                  >
                    <Loader2 v-if="isPending('params-save')" class="admin-spin" :size="13" />
                    <Save v-else :size="13" />
                    应用并保存
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- 03 · 房间环境 -->
          <section class="admin-panel">
            <div class="admin-panel-head">
              <div class="admin-panel-title">
                <span class="admin-num">03</span>
                <span class="admin-label">房间环境 · ENVIRONMENT</span>
              </div>
              <span class="admin-head-note">修改即时广播</span>
            </div>
            <div class="admin-panel-body">
              <div v-if="confirmState" class="admin-confirm" role="alertdialog">
                <div class="admin-confirm-text">
                  <AlertTriangle :size="15" />
                  <div>
                    <b>{{ confirmState.title }}</b>
                    <p>{{ confirmState.text }}</p>
                  </div>
                </div>
                <div class="admin-confirm-actions">
                  <button type="button" class="btn-ghost" @click="cancelConfirm">取消</button>
                  <button type="button" class="btn-primary danger" @click="runConfirm">
                    {{ confirmState.confirmLabel }}
                  </button>
                </div>
              </div>

              <div class="admin-block">
                <span class="admin-block-title">房间进入密码 · ACCESS</span>
                <div class="admin-inline-row">
                  <input
                    v-model="roomPassword"
                    class="text-field"
                    type="text"
                    autocomplete="off"
                    placeholder="留空 = 公开访问；输入新密码后保存"
                    @keydown.enter.prevent="saveRoomPassword"
                  />
                  <button
                    type="button"
                    class="btn-primary"
                    :disabled="isPending('room-password')"
                    @click="saveRoomPassword"
                  >
                    <Loader2 v-if="isPending('room-password')" class="admin-spin" :size="13" />
                    <Save v-else :size="13" />
                    保存密码
                  </button>
                </div>
                <p class="admin-hint">
                  密码由服务端保存，桌面端不回显当前密码；修改后已连接成员会被要求重新连接。
                </p>
              </div>

              <div class="admin-block">
                <div class="admin-row">
                  <div class="admin-row-info">
                    <span class="admin-row-name"><Radio :size="13" /> 直播推流开关</span>
                    <span class="admin-row-desc">{{ streamDescription }}</span>
                  </div>
                  <button
                    type="button"
                    class="switch"
                    :class="{ on: streamState.known && streamState.enabled }"
                    :disabled="isPending('stream')"
                    aria-label="切换直播推流"
                    @click="toggleStream"
                  >
                    <i></i>
                  </button>
                </div>
                <p class="admin-hint">
                  桌面端未映射推流状态字段（服务端不广播到本客户端），开关状态仅记录本次会话操作；
                  按钮动作真实调用 <b class="mono">/api/admin/room/stream</b>。
                </p>
              </div>

              <div class="admin-block">
                <span class="admin-block-title">数据清理 · MAINTENANCE</span>
                <div class="admin-danger-grid">
                  <button
                    v-for="action in CLEAR_ACTIONS"
                    :key="action.target"
                    type="button"
                    class="admin-danger-btn"
                    :disabled="isPending(`clear-${action.target}`)"
                    @click="askClear(action)"
                  >
                    <Loader2
                      v-if="isPending(`clear-${action.target}`)"
                      class="admin-spin"
                      :size="13"
                    />
                    <Trash2 v-else :size="13" />
                    {{ action.label }}
                  </button>
                </div>
              </div>

              <div class="admin-reset">
                <div class="admin-reset-info">
                  <AlertTriangle :size="16" />
                  <div>
                    <span>危险区域 · 系统重置</span>
                    <p>重置播放器、队列与核心状态并广播给所有成员，不可撤销。</p>
                  </div>
                </div>
                <button
                  type="button"
                  class="btn-primary danger"
                  :disabled="isPending('system-reset')"
                  @click="askReset"
                >
                  <RotateCcw :size="13" /> 全系统重置
                </button>
              </div>
            </div>
          </section>
        </div>

        <!-- ============ right column ============ -->
        <div class="admin-col">
          <!-- 04 · 播放与锁定 -->
          <section class="admin-panel">
            <div class="admin-panel-head">
              <div class="admin-panel-title">
                <span class="admin-num">04</span>
                <span class="admin-label">播放与锁定 · PLAYBACK &amp; LOCKS</span>
              </div>
              <span class="status-pill admin-head-pill" :class="lockSummary.kind">{{ lockSummary.text }}</span>
            </div>
            <div class="admin-panel-body">
              <div class="admin-playback-state">
                <span class="admin-state-kicker">当前状态 · LIVE</span>
                <p>{{ playbackSummary }}</p>
              </div>

              <div class="admin-action-grid">
                <button
                  type="button"
                  class="admin-action"
                  :disabled="isPending('player-PAUSE')"
                  @click="runPlayer('PAUSE')"
                >
                  <Loader2 v-if="isPending('player-PAUSE')" class="admin-spin" :size="18" />
                  <component v-else :is="live.playing ? Pause : Play" :size="18" :stroke-width="1.8" />
                  <span>{{ live.playing ? '暂停播放' : '继续播放' }}</span>
                </button>
                <button
                  type="button"
                  class="admin-action"
                  :disabled="isPending('player-SKIP')"
                  @click="runPlayer('SKIP')"
                >
                  <Loader2 v-if="isPending('player-SKIP')" class="admin-spin" :size="18" />
                  <SkipForward v-else :size="18" :stroke-width="1.8" />
                  <span>切歌</span>
                </button>
                <button
                  type="button"
                  class="admin-action"
                  :disabled="isPending('player-SHUFFLE')"
                  @click="runPlayer('SHUFFLE')"
                >
                  <Loader2 v-if="isPending('player-SHUFFLE')" class="admin-spin" :size="18" />
                  <Sliders v-else :size="18" :stroke-width="1.8" />
                  <span>切换播放模式</span>
                </button>
                <button
                  type="button"
                  class="admin-action wide"
                  :disabled="isPending('player-TOGGLE_FAIR_SHUFFLE')"
                  @click="runPlayer('TOGGLE_FAIR_SHUFFLE')"
                >
                  <Loader2
                    v-if="isPending('player-TOGGLE_FAIR_SHUFFLE')"
                    class="admin-spin"
                    :size="15"
                  />
                  <Sparkles v-else :size="15" :stroke-width="1.8" />
                  <span>切换公平随机算法</span>
                </button>
                <button
                  type="button"
                  class="admin-action wide"
                  :disabled="isPending('player-TOGGLE_ALLOW_OFFLINE')"
                  @click="runPlayer('TOGGLE_ALLOW_OFFLINE')"
                >
                  <Loader2
                    v-if="isPending('player-TOGGLE_ALLOW_OFFLINE')"
                    class="admin-spin"
                    :size="15"
                  />
                  <Wifi v-else :size="15" :stroke-width="1.8" />
                  <span>切换离线随机（含/不含离线成员）</span>
                </button>
              </div>
              <p class="admin-hint">
                暂停 / 切歌 / 播放模式等切换类指令由服务端执行；桌面端未映射细分开关状态，结果以 toast
                与服务端广播为准。
              </p>

              <div class="admin-block">
                <span class="admin-block-title">操作锁定 · LOCKS</span>
                <div class="admin-lock-list">
                  <div v-for="row in LOCK_ROWS" :key="row.type" class="admin-lock-row">
                    <span class="admin-lock-name">
                      {{ row.label }}<b class="mono">{{ row.type }}</b>
                    </span>
                    <div class="admin-lock-actions">
                      <button
                        type="button"
                        class="admin-mini"
                        :disabled="isPending(`lock-${row.type}-on`)"
                        @click="runLock(row.type, true)"
                      >
                        <Lock :size="11" /> 锁定
                      </button>
                      <button
                        type="button"
                        class="admin-mini"
                        :disabled="isPending(`lock-${row.type}-off`)"
                        @click="runLock(row.type, false)"
                      >
                        <Unlock :size="11" /> 解锁
                      </button>
                    </div>
                  </div>
                </div>
                <p class="admin-hint">
                  服务端只广播总体锁定状态（{{ lockSummary.text }}），不区分具体类型；因此这里提供显式的
                  「锁定 / 解锁」按钮，而不是猜测每个开关的当前值。
                </p>
              </div>
            </div>
          </section>

          <!-- 05 · 私人电台 / 私人 DJ -->
          <section class="admin-panel">
            <div class="admin-panel-head">
              <div class="admin-panel-title">
                <span class="admin-num">05</span>
                <span class="admin-label">私人电台 / 私人 DJ · PRIVATE_RADIO</span>
              </div>
              <span class="status-pill admin-head-pill" :class="djCookieGate.kind">
                {{ djCookieGate.text }}
              </span>
            </div>
            <div class="admin-panel-body">
              <div class="admin-block">
                <span class="admin-block-title">模式 · 模式即开关</span>
                <div class="admin-segmented" role="group" aria-label="私人电台模式">
                  <button
                    v-for="mode in DJ_MODES"
                    :key="mode.value"
                    type="button"
                    :class="{ active: djMode === mode.value }"
                    :disabled="isPending(`dj-mode-${mode.value}`)"
                    @click="setDjMode(mode.value)"
                  >
                    {{ mode.label }}
                  </button>
                </div>
                <p class="admin-hint">
                  点选 FM / DJ 即开启，再点当前模式回到关闭（OFF）。切换 FM / DJ 前需已配置网易云
                  Cookie，未配置时服务端同样会拒绝并返回原因。
                </p>
              </div>

              <div class="admin-block">
                <span class="admin-block-title">功能开关 · 依赖模式</span>
                <div class="admin-switch-list">
                  <div v-for="item in DJ_SWITCHES" :key="item.field" class="admin-row">
                    <div class="admin-row-info">
                      <span class="admin-row-name">{{ item.label }}</span>
                      <span class="admin-row-desc">{{ item.hint }}</span>
                    </div>
                    <button
                      type="button"
                      class="switch"
                      :class="{ on: Boolean(djConfig[item.field]) }"
                      :disabled="
                        !hasConfigState ||
                        djMode === 'OFF' ||
                        isPending(`dj-${item.field}`)
                      "
                      :aria-label="`切换${item.label}`"
                      @click="toggleDjSwitch(item.field)"
                    >
                      <i></i>
                    </button>
                  </div>
                </div>
                <p class="admin-hint">
                  未收到实时状态时功能开关会禁用（无法判断当前值）；模式按钮仍会提交给服务端校验。
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>

      <footer class="admin-footer">
        <span>
          接口前缀 <b class="mono">{{ serverBase }}/api/admin/*</b> · 所有请求携带
          <b class="mono">X-Admin-Password</b> 与 <b class="mono">Accept: application/json</b>
        </span>
        <span>
          管理员密码仅保存在本机内存（不写入磁盘 / localStorage），退出或刷新即清除；平台凭据由后端保存。
        </span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.admin-page {
  position: fixed;
  inset: var(--h-titlebar) 0 0 0;
  z-index: 800;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--canvas);
  color: var(--ink);
}

.admin-page input,
.admin-page textarea {
  user-select: text;
}

.mono {
  font-family: var(--font-mono);
}

/* ---------- yellow shell header ---------- */

.admin-header {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 13px 24px 12px;
  background: var(--shell);
  border-bottom: 1px solid var(--shell-line);
}

.admin-header-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.admin-kicker {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(20, 20, 20, 0.55);
}

.admin-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.admin-title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.05;
}

.admin-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  background: var(--inverse);
  color: var(--shell);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.admin-conn-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid rgba(20, 20, 20, 0.28);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: rgba(20, 20, 20, 0.68);
  white-space: nowrap;
}

.admin-conn-chip.ok {
  background: var(--inverse);
  border-color: var(--inverse);
  color: var(--shell);
}

.admin-sub {
  margin: 0;
  font-size: 10px;
  font-weight: 500;
  color: rgba(20, 20, 20, 0.62);
}

.admin-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.admin-server {
  max-width: 300px;
  padding: 4px 8px;
  border: 1px solid rgba(20, 20, 20, 0.18);
  background: rgba(252, 252, 253, 0.4);
  font-size: 10px;
  color: rgba(20, 20, 20, 0.62);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- scroll area & grid ---------- */

.admin-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 24px 32px;
}

.admin-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 14px;
  border: 1px dashed rgba(20, 20, 20, 0.24);
  background: var(--surface);
  font-size: 10px;
  line-height: 1.55;
  color: rgba(20, 20, 20, 0.55);
}

.admin-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.16fr) minmax(0, 0.94fr);
  gap: 16px;
  align-items: start;
}

.admin-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* ---------- panels ---------- */

.admin-panel {
  border: 1px solid var(--line);
  background: var(--canvas);
  min-width: 0;
}

.admin-panel.pulse {
  animation: admin-panel-pulse 1.4s var(--ease-out);
}

@keyframes admin-panel-pulse {
  0%,
  100% {
    box-shadow: none;
  }
  35% {
    box-shadow: 0 0 0 3px rgba(255, 205, 56, 0.9), 0 0 0 1px var(--inverse);
  }
}

.admin-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  background: var(--inverse);
  color: var(--inverse-text);
}

.admin-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.admin-num {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  background: var(--shell);
  color: var(--ink);
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.admin-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: rgba(252, 252, 253, 0.84);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.admin-head-note {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: rgba(252, 252, 253, 0.45);
  text-align: right;
  white-space: nowrap;
}

.admin-head-pill {
  flex: 0 0 auto;
  border-color: rgba(252, 252, 253, 0.5);
  color: rgba(252, 252, 253, 0.86);
}

.admin-head-pill.ok {
  background: var(--shell);
  border-color: var(--shell);
  color: var(--ink);
}

.admin-head-pill.warn {
  border-color: var(--shell);
  color: var(--shell);
}

.admin-panel-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  min-width: 0;
}

/* ---------- blocks / rows ---------- */

.admin-block {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}

.admin-block + .admin-block {
  padding-top: 13px;
  border-top: 1px solid var(--line);
}

.admin-block-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: rgba(20, 20, 20, 0.42);
}

.admin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  border-top: 1px solid var(--line);
}

.admin-row:first-child {
  border-top: 0;
  padding-top: 0;
}

.admin-row-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.admin-row-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}

.admin-row-desc {
  font-size: 10px;
  font-weight: 500;
  line-height: 1.45;
  color: rgba(20, 20, 20, 0.42);
}

.admin-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

/* ---------- credentials ---------- */

.admin-textarea {
  width: 100%;
  min-height: 62px;
  padding: 8px 10px;
  border: 1px solid rgba(20, 20, 20, 0.2);
  background: var(--canvas);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color var(--dur-1);
}

.admin-textarea:focus {
  border-color: var(--inverse);
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.admin-textarea.masked {
  -webkit-text-security: disc;
  letter-spacing: 0.1em;
}

.admin-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

/* ---------- buttons ---------- */

.admin-mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid rgba(20, 20, 20, 0.2);
  background: var(--canvas);
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-2);
  transition: background var(--dur-1), border-color var(--dur-1);
}

.admin-mini:hover:not(:disabled) {
  background: var(--surface);
  border-color: rgba(20, 20, 20, 0.42);
}

.admin-mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.admin-spin {
  animation: admin-spin 900ms linear infinite;
}

@keyframes admin-spin {
  to {
    transform: rotate(360deg);
  }
}

.admin-page .switch:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* ---------- params ---------- */

.admin-params {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}

.admin-param {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.admin-param-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 10px;
  font-weight: 600;
  color: rgba(20, 20, 20, 0.62);
}

.admin-param-label b {
  font-size: 9px;
  font-weight: 600;
  color: rgba(20, 20, 20, 0.36);
  white-space: nowrap;
}

.admin-param .text-field {
  height: 28px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.admin-param-api {
  font-size: 8px;
  letter-spacing: 0.04em;
  color: rgba(20, 20, 20, 0.28);
}

.admin-save-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}

/* ---------- hints ---------- */

.admin-hint {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: rgba(20, 20, 20, 0.42);
}

.admin-hint b {
  font-weight: 600;
  color: rgba(20, 20, 20, 0.58);
}

.admin-error {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--danger);
}

/* ---------- room env ---------- */

.admin-inline-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.admin-danger-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.admin-danger-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid rgba(20, 20, 20, 0.16);
  background: var(--canvas);
  font-size: 10px;
  font-weight: 600;
  color: rgba(20, 20, 20, 0.62);
  transition: background var(--dur-1), color var(--dur-1), border-color var(--dur-1);
}

.admin-danger-btn:hover:not(:disabled) {
  border-color: rgba(164, 38, 44, 0.4);
  background: #fdf2f2;
  color: var(--danger);
}

.admin-danger-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.admin-reset {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid rgba(164, 38, 44, 0.3);
  background: #fdf2f2;
}

.admin-reset-info {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  color: var(--danger);
}

.admin-reset-info span {
  font-size: 11px;
  font-weight: 700;
}

.admin-reset-info p {
  margin: 2px 0 0;
  font-size: 10px;
  line-height: 1.45;
  color: rgba(20, 20, 20, 0.55);
}

.admin-confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(164, 38, 44, 0.45);
  background: #fdf2f2;
}

.admin-confirm-text {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--danger);
}

.admin-confirm-text b {
  font-size: 11px;
}

.admin-confirm-text p {
  margin: 2px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: rgba(20, 20, 20, 0.6);
}

.admin-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ---------- playback / locks ---------- */

.admin-playback-state {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  background: var(--surface);
}

.admin-state-kicker {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(20, 20, 20, 0.4);
}

.admin-playback-state p {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

.admin-action-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.admin-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 62px;
  padding: 9px 6px;
  border: 1px solid rgba(20, 20, 20, 0.16);
  background: var(--canvas);
  font-size: 10px;
  font-weight: 700;
  color: var(--ink-2);
  text-align: center;
  transition: background var(--dur-1), border-color var(--dur-1);
}

.admin-action:hover:not(:disabled) {
  border-color: var(--inverse);
  background: var(--surface);
}

.admin-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.admin-action.wide {
  grid-column: span 3;
  flex-direction: row;
  min-height: 32px;
  gap: 8px;
  padding: 6px 8px;
}

.admin-lock-list {
  display: flex;
  flex-direction: column;
}

.admin-lock-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--line);
}

.admin-lock-row:first-child {
  border-top: 0;
  padding-top: 0;
}

.admin-lock-name {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-2);
}

.admin-lock-name b {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: rgba(20, 20, 20, 0.32);
}

.admin-lock-actions {
  display: flex;
  gap: 6px;
}

/* ---------- private radio ---------- */

.admin-segmented {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid rgba(20, 20, 20, 0.18);
}

.admin-segmented button {
  height: 30px;
  font-size: 11px;
  font-weight: 700;
  color: rgba(20, 20, 20, 0.55);
  border-right: 1px solid rgba(20, 20, 20, 0.12);
  transition: background var(--dur-1), color var(--dur-1);
}

.admin-segmented button:last-child {
  border-right: 0;
}

.admin-segmented button:hover:not(:disabled) {
  background: var(--surface);
  color: var(--ink);
}

.admin-segmented button.active {
  background: var(--inverse);
  color: var(--shell);
}

.admin-segmented button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---------- footer ---------- */

.admin-footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 9px;
  letter-spacing: 0.04em;
  line-height: 1.5;
  color: rgba(20, 20, 20, 0.36);
}

.admin-footer b {
  font-weight: 600;
  color: rgba(20, 20, 20, 0.52);
}

/* ---------- login gate ---------- */

.admin-gate {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  place-items: center;
  padding: 24px;
}

.admin-gate-card {
  width: min(540px, 100%);
  border: 1px solid var(--line-strong);
  background: var(--canvas);
  box-shadow: 0 20px 50px rgba(20, 19, 20, 0.12);
}

.admin-gate-bar {
  height: 8px;
  background: var(--shell);
  border-bottom: 1px solid var(--shell-line);
}

.admin-gate-inner {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 22px 24px 24px;
}

.admin-gate-kicker {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(20, 20, 20, 0.42);
}

.admin-gate-title {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.admin-gate-desc {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: rgba(20, 20, 20, 0.55);
}

.admin-gate-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.admin-secret-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.admin-gate-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.admin-gate-note {
  margin: 0;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 9px;
  line-height: 1.5;
  color: rgba(20, 20, 20, 0.38);
}

.admin-gate-note b {
  font-weight: 600;
  color: rgba(20, 20, 20, 0.5);
}

/* ---------- responsive ---------- */

@media (max-width: 1180px) {
  .admin-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .admin-header {
    align-items: flex-start;
  }
}

@media (max-width: 720px) {
  .admin-header,
  .admin-scroll {
    padding-left: 16px;
    padding-right: 16px;
  }

  .admin-params {
    grid-template-columns: minmax(0, 1fr);
  }

  .admin-action-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .admin-action.wide {
    grid-column: span 2;
  }

  .admin-danger-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

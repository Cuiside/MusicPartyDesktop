<script setup>
/**
 * Admin password dialog — entry point for the desktop admin console.
 *
 * The password is verified against `POST /api/admin/verify` **on the current session
 * base** and, on success, is kept only in the in-memory `adminAuth` store (never
 * persisted) and bound to that base (D-08). Emits `verified` so the caller can open
 * `AdminView`; emits `close` on cancel/backdrop; `open-settings` jumps to the local
 * admin password setup when the server reports `adminConfigured=false` (D-09).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Eye, EyeOff, KeyRound, Loader2, ShieldCheck, X } from 'lucide-vue-next'
import { adminAuth, verifyAdmin } from '../core/live/admin'
import { live } from '../core/live/state'
import { activeBase } from '../core/live/session'
import { fetchConfigMeta } from '../core/live/api'
import { pushToast } from '../core/toast'

const props = defineProps({
  open: { type: Boolean, default: false }
})
const emit = defineEmits(['verified', 'close', 'open-settings'])

const password = ref('')
const visible = ref(false)
const localError = ref('')
const inputRef = ref(null)
const serverConfigured = ref(null)
const metadataLoading = ref(false)

/** 当前生效的服务器 base：已加入房间用会话 base，否则用已保存地址（D-08/D-16）。 */
const serverBase = computed(() => live.sessionBase || activeBase())
/** 是否为“本机服务”（本地启动器管理，首次启动会在设置里设置管理员密码）。 */
const isLocalTarget = computed(() => {
  try {
    const host = new URL(serverBase.value).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
})
const adminNotConfigured = computed(() => serverConfigured.value === false)
const errorText = computed(() => localError.value || adminAuth.error)

/** 打开时读取 /api/config：老服务端无 adminConfigured 字段 → 未知（不误报）。 */
const loadServerMetadata = async () => {
  metadataLoading.value = true
  try {
    const meta = await fetchConfigMeta({ deriveRoomName: false })
    serverConfigured.value = meta?.adminConfigured ?? null
  } catch {
    serverConfigured.value = null
  } finally {
    metadataLoading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    password.value = ''
    visible.value = false
    localError.value = ''
    adminAuth.error = ''
    serverConfigured.value = null
    void loadServerMetadata()
    nextTick(() => inputRef.value?.focus())
  },
  { immediate: true }
)

const submit = async () => {
  if (adminAuth.verifying) return
  localError.value = ''
  const candidate = password.value
  if (!candidate.trim()) {
    // 空 / 纯空白本地先拒绝（服务端也拒绝空管理员密码，D-09）。
    localError.value = '请输入管理员密码（不能为空或纯空白）'
    return
  }
  const ok = await verifyAdmin(candidate)
  if (!ok) {
    localError.value = adminAuth.error || '认证失败，请重试'
    return
  }
  password.value = ''
  localError.value = ''
  pushToast('管理员认证成功')
  emit('verified')
}

const cancel = () => {
  if (adminAuth.verifying) return
  password.value = ''
  localError.value = ''
  emit('close')
}

const onKeydown = (event) => {
  if (event.key !== 'Escape' || !props.open) return
  event.stopPropagation()
  cancel()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="dialog-backdrop" @mousedown.self="cancel">
        <div
          class="dialog admin-auth-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-auth-title"
        >
          <div class="admin-auth-head">
            <span class="label">管理员认证 · ADMIN LOGIN</span>
            <div class="admin-auth-head-row">
              <h2 id="admin-auth-title" class="admin-auth-title">
                <ShieldCheck :size="16" :stroke-width="2" /> 进入管理终端
              </h2>
              <button type="button" class="admin-auth-close" title="取消" @click="cancel">
                <X :size="16" :stroke-width="1.8" />
              </button>
            </div>
          </div>

          <form class="admin-auth-form" novalidate @submit.prevent="submit">
            <p class="admin-auth-desc">
              管理终端会直接修改服务端配置、平台凭据与房间状态。请输入服务端配置的管理员密码；
              密码只保存在本机内存，退出或刷新即清除。
            </p>

            <label class="admin-auth-field">
              <span class="admin-auth-label"><KeyRound :size="12" /> 管理员密码</span>
              <span class="admin-auth-input-row">
                <input
                  id="admin-auth-password"
                  ref="inputRef"
                  v-model="password"
                  class="text-field"
                  :type="visible ? 'text' : 'password'"
                  autocomplete="current-password"
                  spellcheck="false"
                  placeholder="输入管理员密码"
                  :aria-invalid="errorText ? 'true' : 'false'"
                  :disabled="adminAuth.verifying"
                />
                <button
                  type="button"
                  class="admin-auth-eye"
                  :title="visible ? '隐藏密码' : '显示密码'"
                  @click="visible = !visible"
                >
                  <component :is="visible ? EyeOff : Eye" :size="14" :stroke-width="1.8" />
                </button>
              </span>
            </label>

            <p v-if="errorText" class="admin-auth-error" role="alert">{{ errorText }}</p>
            <div v-else class="admin-auth-hint">
              <p v-if="adminNotConfigured" class="admin-auth-warn" role="status">
                <b>管理员密码未配置</b>：请先在设置中为本机服务设置管理员密码（本地启动器会在首次启动时要求设置），
                或联系服务器管理员完成配置。未配置时服务端拒绝空密码认证。
              </p>
              <p v-else-if="isLocalTarget" class="admin-auth-hint-line">
                这是本机服务：管理员密码由本地启动器保管。忘记密码时可在「设置 → 服务与连接 → 本机管理员密码」中查看/重新生成。
                <button type="button" class="text-btn" @click="emit('open-settings')">打开设置</button>
              </p>
              <p v-if="metadataLoading" class="admin-auth-hint-line">正在读取服务器配置状态…</p>
              <p class="admin-auth-hint-line">
                服务端地址 <b class="mono">{{ serverBase }}</b>
                <template v-if="live.sessionBase"> · 已绑定当前会话</template>
                · 密码在服务端 <b class="mono">ADMIN_PASSWORD</b> / <b class="mono">application.yml</b> 中配置。
              </p>
            </div>

            <div class="admin-auth-actions">
              <button type="button" class="btn-ghost" :disabled="adminAuth.verifying" @click="cancel">
                取消
              </button>
              <button type="submit" class="btn-primary" :disabled="adminAuth.verifying">
                <Loader2 v-if="adminAuth.verifying" class="admin-auth-spin" :size="14" :stroke-width="2.2" />
                {{ adminAuth.verifying ? '验证中…' : '验证并进入' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.admin-auth-dialog {
  width: min(440px, calc(100vw - 48px));
}

.admin-auth-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 20px 0;
}

.admin-auth-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.admin-auth-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.admin-auth-close {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  color: rgba(var(--ink-rgb), 0.5);
  border: 1px solid rgba(var(--ink-rgb), 0.16);
  transition: background var(--dur-1), color var(--dur-1), border-color var(--dur-1);
}

.admin-auth-close:hover {
  background: var(--inverse);
  border-color: var(--inverse);
  color: var(--shell);
}

.admin-auth-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 20px 18px;
}

.admin-auth-desc {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: rgba(var(--ink-rgb), 0.55);
}

.admin-auth-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.admin-auth-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(var(--ink-rgb), 0.42);
}

.admin-auth-input-row {
  display: flex;
  align-items: stretch;
  gap: 0;
}

.admin-auth-input-row .text-field {
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  height: 34px;
  outline-offset: -2px;
}

.admin-auth-eye {
  flex: 0 0 36px;
  width: 36px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(var(--ink-rgb), 0.2);
  background: var(--canvas);
  color: rgba(var(--ink-rgb), 0.55);
  transition: background var(--dur-1), color var(--dur-1);
}

.admin-auth-eye:hover {
  background: var(--surface);
  color: var(--ink);
}

.admin-auth-error {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--danger);
}

.admin-auth-hint {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: rgba(var(--ink-rgb), 0.4);
}

.admin-auth-hint-line {
  margin: 0;
  font-size: 10px;
  line-height: 1.55;
  color: rgba(var(--ink-rgb), 0.4);
}

.admin-auth-warn {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.55;
  color: var(--danger);
}

.admin-auth-warn b {
  color: var(--danger);
}

.admin-auth-hint-line .text-btn {
  margin-left: 4px;
  font-size: 10px;
}

.admin-auth-hint b {
  font-weight: 600;
  color: rgba(var(--ink-rgb), 0.56);
}

.admin-auth-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 2px;
}

.admin-auth-spin {
  animation: admin-auth-spin 900ms linear infinite;
}

@keyframes admin-auth-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

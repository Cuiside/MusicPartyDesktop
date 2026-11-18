<script setup>
import { computed, reactive, ref, watch } from 'vue'
import {
  AlertCircle,
  CheckCircle2,
  Link2,
  Loader2,
  Server,
  ShieldCheck,
  UserRound,
  Wifi,
  WifiOff
} from 'lucide-vue-next'
import { DEFAULT_SERVER } from '../core/live/config'
import {
  friendlyJoinError,
  parseServerInput,
  probeServer
} from './OnboardingView.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  joining: { type: Boolean, default: false },
  error: { type: String, default: '' },
  defaults: { type: Object, default: () => ({}) },
  mineServer: { type: String, default: 'http://127.0.0.1:8080' }
})
const emit = defineEmits(['connect', 'close'])

const form = reactive({
  serverUrl: props.defaults.serverUrl || DEFAULT_SERVER,
  name: props.defaults.name || '游客',
  password: ''
})
const advanced = ref(false)
const inlineError = ref('')
const inviteNotice = ref('')
const probe = reactive({ status: 'idle', kind: '', message: '', note: '' })
let probeSeq = 0

const errorText = computed(() => inlineError.value || friendlyJoinError(props.error))
const passwordInvalid = computed(() => /密码/.test(errorText.value))
const checking = computed(() => probe.status === 'checking')
const mineHost = computed(() => {
  const parsed = parseServerInput(props.mineServer)
  return parsed.ok ? parsed.host : props.mineServer || '127.0.0.1:8080'
})
const serverHost = computed(() => {
  const parsed = parseServerInput(form.serverUrl)
  return parsed.ok ? parsed.host : form.serverUrl || DEFAULT_SERVER
})

const resetProbe = () => {
  probe.status = 'idle'
  probe.kind = ''
  probe.message = ''
  probe.note = ''
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.serverUrl = props.defaults.serverUrl || form.serverUrl || DEFAULT_SERVER
    form.name = props.defaults.name || form.name || '游客'
    form.password = ''
    advanced.value = false
    inlineError.value = ''
    inviteNotice.value = ''
    resetProbe()
  }
)

const runProbe = async () => {
  const seq = ++probeSeq
  probe.status = 'checking'
  probe.message = '正在检测服务器…'
  probe.note = ''
  const result = await probeServer(form.serverUrl)
  if (seq !== probeSeq) return
  probe.status = result.status
  probe.kind = result.kind || ''
  probe.message = result.message
  probe.note = result.note || ''
}

const onServerBlur = () => {
  const parsed = parseServerInput(form.serverUrl)
  if (!parsed.ok) return
  const fromInvite = parsed.invitePassword && !form.password
  if (fromInvite) form.password = parsed.invitePassword
  if (parsed.hasQuery) {
    form.serverUrl = parsed.url
    inviteNotice.value = fromInvite
      ? '已从邀请链接识别服务器地址，并自动填入房间密码'
      : '已从邀请链接识别服务器地址'
  }
}

const onServerInput = () => {
  inviteNotice.value = ''
  inlineError.value = ''
  resetProbe()
}

const submit = () => {
  if (props.joining) return
  inlineError.value = ''
  const parsed = parseServerInput(form.serverUrl)
  if (!parsed.ok) {
    inlineError.value = parsed.error
    advanced.value = true
    return
  }
  form.serverUrl = parsed.url
  emit('connect', {
    serverUrl: parsed.url,
    name: form.name.trim() || '游客',
    password: form.password,
    mine: false
  })
}

/** Enter the user's own room (local service by default, or their saved server). */
const enterMine = () => {
  if (props.joining) return
  const parsed = parseServerInput(props.mineServer)
  if (!parsed.ok) {
    inlineError.value = parsed.error
    return
  }
  inlineError.value = ''
  emit('connect', {
    serverUrl: parsed.url,
    name: form.name.trim() || '游客',
    password: form.password,
    mine: true
  })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="dialog-backdrop" @mousedown.self="emit('close')">
        <div
          class="dialog join-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="join-dialog-title"
        >
          <div class="join-head">
            <span class="label">加入房间 · JOIN A ROOM</span>
            <div class="join-head-row">
              <span id="join-dialog-title" class="join-title">加入 Music Party 房间</span>
              <button
                type="button"
                class="onb-probe-chip"
                :class="probe.status"
                title="检测服务器连接"
                @click="runProbe"
              >
                <Loader2 v-if="checking" class="onb-spin" :size="12" :stroke-width="2" />
                <Wifi v-else-if="probe.status === 'ok'" :size="12" :stroke-width="2" />
                <WifiOff v-else-if="probe.status === 'fail'" :size="12" :stroke-width="2" />
                <Server v-else :size="12" :stroke-width="2" />
                {{
                  checking
                    ? '检测中…'
                    : probe.status === 'ok'
                      ? '服务器可达'
                      : probe.status === 'fail'
                        ? '连接异常'
                        : '未连接'
                }}
              </button>
            </div>
          </div>

          <form class="join-form" novalidate @submit.prevent="submit">
            <div class="join-row">
              <label class="join-field">
                <span class="join-label"><UserRound :size="12" /> 昵称</span>
                <input
                  id="join-dialog-name"
                  v-model="form.name"
                  class="text-field"
                  maxlength="32"
                  autocomplete="nickname"
                  placeholder="其他人在房间里看到的名字（默认：游客）"
                  @keydown.enter.prevent="submit"
                />
              </label>
              <label class="join-field">
                <span class="join-label"><ShieldCheck :size="12" /> 房间密码</span>
                <input
                  id="join-dialog-password"
                  v-model="form.password"
                  class="text-field"
                  type="password"
                  autocomplete="current-password"
                  placeholder="房间没有密码时留空"
                  :aria-invalid="passwordInvalid ? 'true' : 'false'"
                  @keydown.enter.prevent="submit"
                />
              </label>
            </div>

            <button
              type="button"
              class="onb-server-row"
              :aria-expanded="advanced ? 'true' : 'false'"
              aria-controls="join-dialog-advanced"
              @click="advanced = !advanced"
            >
              <Server :size="13" :stroke-width="1.8" />
              <span class="onb-server-key">服务器</span>
              <span class="onb-server-value">{{ serverHost }}</span>
              <span class="onb-server-action">{{ advanced ? '收起' : '更改' }}</span>
            </button>

            <div v-if="advanced" id="join-dialog-advanced" class="join-advanced">
              <label class="join-field">
                <span class="join-label"><Link2 :size="12" /> 服务器地址 / 邀请链接</span>
                <input
                  id="join-dialog-server"
                  v-model="form.serverUrl"
                  class="text-field"
                  spellcheck="false"
                  placeholder="http://127.0.0.1:8080 或 https://your-server.example.com"
                  @blur="onServerBlur"
                  @input="onServerInput"
                  @keydown.enter.prevent="submit"
                />
              </label>
              <div class="onb-probe-row">
                <button type="button" class="btn-ghost onb-check" :disabled="checking" @click="runProbe">
                  <Loader2 v-if="checking" class="onb-spin" :size="13" :stroke-width="2" />
                  <Wifi v-else :size="13" :stroke-width="1.8" />
                  {{ checking ? '检测中…' : '检测连接' }}
                </button>
                <span class="onb-probe-result" :class="probe.status" role="status" aria-live="polite">
                  <template v-if="probe.status === 'ok'">
                    <CheckCircle2 :size="13" :stroke-width="2" /> {{ probe.message }}
                  </template>
                  <template v-else-if="probe.status === 'fail'">
                    <AlertCircle :size="13" :stroke-width="2" /> {{ probe.message }}
                  </template>
                  <template v-else-if="probe.status === 'checking'">{{ probe.message }}</template>
                  <template v-else>尚未检测 · 也可以直接尝试加入</template>
                </span>
              </div>
              <p v-if="probe.note && probe.status === 'ok'" class="onb-probe-note">{{ probe.note }}</p>
              <p v-if="inviteNotice" class="onb-invite-note">{{ inviteNotice }}</p>
            </div>

            <p v-if="errorText" class="join-error" role="alert">{{ errorText }}</p>
            <p v-else class="join-hint">
              服务器地址向发房间链接给你的朋友获取；本地自建服务默认 127.0.0.1:8080。
            </p>
          </form>

          <div class="join-actions">
            <button type="button" class="text-btn join-mine-link" :disabled="joining" @click="enterMine">
              <Server :size="12" /> 进入我的房间 · {{ mineHost }}
            </button>
            <div class="join-actions-right">
              <button class="btn-ghost" :disabled="joining" @click="emit('close')">取消</button>
              <button id="join-dialog-submit" class="btn-primary" :disabled="joining" @click="submit">
                <Loader2 v-if="joining" class="onb-spin" :size="14" :stroke-width="2.2" />
                {{ joining ? '连接中…' : '加入房间' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

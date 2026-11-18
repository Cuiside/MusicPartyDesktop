<script>
/**
 * Shared join-form helpers (used by OnboardingView and JoinDialog).
 *
 * The public build deliberately ships **no** fixed server address: users type the
 * address of their own MusicParty server (or of a friend's server). The default is
 * the local backend origin, shown only as an example/placeholder.
 */
import { DEFAULT_SERVER, normalizeServerUrl } from '../core/live/config'

/** Scheme detector for user input like `host:port` vs `https://host`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Is this address the local machine? Used to label「我的房间」as the local service
 * instead of a saved remote server.
 * @param {string} raw
 * @returns {boolean}
 */
export function isLocalHostServer(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return false
  try {
    const url = new URL(SCHEME_RE.test(value) ? value : `http://${value}`)
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * Validate + normalize a user supplied server address or invite link.
 *
 * Accepts `127.0.0.1:8080`, `http://host:8080/`, `https://host/prefix`,
 * `wss://host/ws` and full room invite links (extra query params are ignored, a
 * `password`/`pwd`/`roomPassword` param is extracted for convenience).
 *
 * @param {string} raw
 * @returns {{ ok: boolean, url?: string, host?: string, invitePassword?: string, hasQuery?: boolean, error?: string }}
 */
export function parseServerInput(raw) {
  const value = String(raw ?? '').trim()
  if (!value) {
    return { ok: false, error: '请填写服务器地址：本机服务一般是 127.0.0.1:8080，或使用朋友给你的邀请链接' }
  }
  if (/\s/.test(value)) {
    return { ok: false, error: '地址中不能包含空格，请检查是否粘贴完整' }
  }
  const withScheme = SCHEME_RE.test(value) ? value : `http://${value}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return {
      ok: false,
      error: '地址格式不正确：示例 http://127.0.0.1:8080 或 https://your-server.example.com'
    }
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    return { ok: false, error: '只支持 http:// 或 https:// 开头的服务器地址' }
  }
  if (!url.hostname) {
    return { ok: false, error: '地址缺少主机名，请检查后重试（示例：http://127.0.0.1:8080）' }
  }
  // D-02：交给统一的 normalizeServerUrl 决定协议（裸公网域名→https，回环/私网→http，
  // 显式 http/https/ws/wss 尊重）。绝不静默回退 localhost；无效输入明确报错。
  const normalized = normalizeServerUrl(value)
  if (!normalized) {
    return { ok: false, error: '无法识别这个地址，请检查协议、主机名与端口号' }
  }
  const invitePassword =
    url.searchParams.get('password') ||
    url.searchParams.get('pwd') ||
    url.searchParams.get('roomPassword') ||
    ''
  return {
    ok: true,
    url: normalized,
    host: new URL(normalized).host,
    invitePassword,
    hasQuery: url.search.length > 1
  }
}

/** Map raw client/server errors to one clear, actionable sentence. */
export function friendlyJoinError(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (/需要密码|请输入房间密码|密码保护/.test(text)) {
    return '该房间启用了密码保护，请在「房间密码」中填写后重试。'
  }
  if (/INVALID_ROOM_PASSWORD|房间密码错误/.test(text)) {
    return '房间密码错误：请向房主确认密码后重新输入。'
  }
  if (/429|尝试次数过多|频繁/.test(text)) {
    return '尝试次数过多：请稍后再试，或向房主确认房间密码。'
  }
  if (/超时|timeout|CONNECT|ECONN|Failed to fetch|network|WebSocket|无法访问|无法连接/i.test(text)) {
    return '无法连接服务器：请检查地址是否正确、服务是否已启动、网络是否可达。'
  }
  if (/HTTP\s*\d{3}/i.test(text)) {
    return `服务器返回错误（${text}）：该地址可能不是 MusicParty 服务，请检查端口或路径。`
  }
  return text
}

/**
 * GET a MusicParty REST path, through the Electron main-process bridge when
 * available (no CORS) or plain fetch otherwise.
 * @param {string} base Normalized base URL.
 * @param {string} path e.g. `/api/config`.
 * @param {((options: Object) => Promise<Object>) | undefined} bridge
 * @returns {Promise<{ ok: boolean, status: number, body: string, contentType: string, error: string }>}
 */
async function httpGet(base, path, bridge) {
  const url = `${base}${path}`
  if (bridge) {
    /** @type {{ ok?: boolean, status?: number, bodyText?: string, contentType?: string, error?: string }} */
    let response
    try {
      response = await Promise.race([
        bridge({ url, method: 'GET', timeout: 6000 }),
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 8200)
          if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
        })
      ])
    } catch (error) {
      return { ok: false, status: 0, body: '', contentType: '', error: String(error?.message || error) }
    }
    const status = Number(response?.status || 0)
    return {
      ok: Boolean(response?.ok) && status >= 200 && status < 300,
      status,
      body: String(response?.bodyText ?? ''),
      contentType: String(response?.contentType ?? ''),
      error: String(response?.error ?? '')
    }
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), 8000) : 0
  try {
    const response = await fetch(url, { method: 'GET', signal: controller ? controller.signal : undefined })
    const body = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      body,
      contentType: response.headers.get('content-type') || '',
      error: ''
    }
  } catch (error) {
    return { ok: false, status: 0, body: '', contentType: '', error: String(error?.message || error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Reachability probe for the join forms. Distinguishes: invalid address,
 * unreachable/timeout, HTTP error, HTML fallback (wrong app on that port) and a
 * working MusicParty backend (bonus: whether the room is password protected).
 *
 * @param {string} raw User input (address or invite link).
 * @returns {Promise<{ status: 'ok' | 'fail', kind: string, host: string, message: string, note?: string }>}
 */
export async function probeServer(raw) {
  const parsed = parseServerInput(raw)
  if (!parsed.ok) {
    return { status: 'fail', kind: 'invalid', host: '', message: parsed.error }
  }
  const host = parsed.host || ''
  let bridge
  try {
    bridge = typeof window !== 'undefined' ? window.mpDesktop?.http?.request : undefined
  } catch {
    bridge = undefined
  }

  let response
  try {
    response = await httpGet(parsed.url, '/api/config', bridge)
  } catch (error) {
    return {
      status: 'fail',
      kind: 'network',
      host,
      message: '无法访问服务器：请确认地址与端口正确、服务已启动，并且网络可达。'
    }
  }

  if (response.status === 0 && !response.error) {
    return {
      status: 'fail',
      kind: 'network',
      host,
      message: '无法访问服务器：请确认地址与端口正确、服务已启动，并且网络可达。'
    }
  }
  if (response.error) {
    const timeout = /timeout|abort/i.test(response.error)
    return {
      status: 'fail',
      kind: timeout ? 'timeout' : 'network',
      host,
      message: timeout
        ? '连接超时：服务器可能未启动，或被防火墙 / 代理拦截。'
        : '无法访问服务器：请确认地址与端口正确、服务已启动，并且网络可达。'
    }
  }
  if (response.status >= 500) {
    return {
      status: 'fail',
      kind: 'http',
      host,
      message: `服务器返回 HTTP ${response.status}：服务端异常或该地址不是 MusicParty 服务。`
    }
  }
  if (response.status >= 400) {
    return {
      status: 'fail',
      kind: 'http',
      host,
      message: `未找到 MusicParty 接口（HTTP ${response.status}）：请检查端口、路径，或确认该地址是 MusicParty 服务。`
    }
  }
  const body = response.body.trim()
  if (body.startsWith('<')) {
    return {
      status: 'fail',
      kind: 'html',
      host,
      message: '该地址返回的是网页而不是 MusicParty 接口：请检查端口或路径是否正确。'
    }
  }
  let config
  try {
    config = body ? JSON.parse(body) : null
  } catch {
    config = null
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      status: 'fail',
      kind: 'json',
      host,
      message: '接口返回内容不是 MusicParty 配置：该地址可能不是 MusicParty 服务。'
    }
  }

  // Best-effort: does the room require a password? Ignore failures silently.
  let note = 'MusicParty 服务正常'
  const auth = await httpGet(parsed.url, '/api/auth/status', bridge).catch(() => null)
  if (auth && auth.ok && auth.body.trim().startsWith('{')) {
    try {
      const status = JSON.parse(auth.body)
      if (status && typeof status.hasProtection === 'boolean') {
        note = status.hasProtection ? '该房间启用了密码保护，加入前请填写房间密码' : '房间未设置密码，可直接加入'
      }
    } catch {
      /* keep generic note */
    }
  }
  return { status: 'ok', kind: 'ok', host, message: `服务器可达 · ${host}`, note }
}
</script>

<script setup>
const baseUrl = import.meta.env.BASE_URL
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  DoorOpen,
  Link2,
  Loader2,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Wifi,
  WifiOff
} from 'lucide-vue-next'
import { DEFAULT_SERVER } from '../core/live/config'

const props = defineProps({
  defaults: { type: Object, default: () => ({}) },
  joining: { type: Boolean, default: false },
  error: { type: String, default: '' },
  initialAdvanced: { type: Boolean, default: false }
})
const emit = defineEmits(['connect', 'demo', 'settings', 'clear-data'])

const savedRemote = (() => {
  const saved = String(props.defaults.serverUrl || '')
  if (!saved || saved === DEFAULT_SERVER || isLocalHostServer(saved)) return ''
  return saved
})()

/** `'mine'` = the user's own room (local service by default), `'join'` = a friend's server. */
const mode = ref(props.initialAdvanced ? 'join' : 'mine')
const form = reactive({
  name: props.defaults.name || '游客',
  password: '',
  mineServer: props.defaults.mineServer || DEFAULT_SERVER,
  joinServer: savedRemote
})
const joinAdvanced = ref(Boolean(props.initialAdvanced) || Boolean(savedRemote))
const mineEditing = ref(false)
const inlineError = ref('')
const inviteNotice = ref('')
const probe = reactive({ status: 'idle', kind: '', host: '', message: '', note: '' })
let probeSeq = 0

const errorText = computed(() => inlineError.value || friendlyJoinError(props.error))
const passwordInvalid = computed(() => /密码/.test(errorText.value))
const checking = computed(() => probe.status === 'checking')
const targetServer = computed(() =>
  mode.value === 'mine' ? form.mineServer : form.joinServer || savedRemote
)
const targetHost = computed(() => {
  const parsed = parseServerInput(targetServer.value)
  return parsed.ok ? parsed.host : '未填写地址'
})
const mineIsLocal = computed(() => isLocalHostServer(form.mineServer))
const mineHost = computed(() => {
  const parsed = parseServerInput(form.mineServer)
  return parsed.ok ? parsed.host : form.mineServer || DEFAULT_SERVER
})

const resetProbe = () => {
  probe.status = 'idle'
  probe.kind = ''
  probe.host = ''
  probe.message = ''
  probe.note = ''
}

const runProbe = async () => {
  if (mode.value === 'join' && !form.joinServer && !savedRemote) {
    probe.status = 'fail'
    probe.kind = 'invalid'
    probe.message = '请先填写朋友的服务器地址或邀请链接，再检测连接。'
    probe.note = ''
    return
  }
  const seq = ++probeSeq
  probe.status = 'checking'
  probe.kind = ''
  probe.message = '正在检测服务器…'
  probe.note = ''
  const result = await probeServer(targetServer.value)
  if (seq !== probeSeq) return
  probe.status = result.status
  probe.kind = result.kind || ''
  probe.host = result.host || ''
  probe.message = result.message
  probe.note = result.note || ''
}

const switchMode = (next) => {
  if (mode.value === next) return
  mode.value = next
  inlineError.value = ''
  inviteNotice.value = ''
  resetProbe()
  if (next === 'join' && !joinAdvanced.value) joinAdvanced.value = true
}

const useDefaultMineServer = () => {
  form.mineServer = DEFAULT_SERVER
  inviteNotice.value = ''
  resetProbe()
}

const onMineServerInput = () => {
  inviteNotice.value = ''
  inlineError.value = ''
  resetProbe()
}

const onJoinServerInput = () => {
  inviteNotice.value = ''
  inlineError.value = ''
  resetProbe()
}

const onJoinServerBlur = () => {
  const parsed = parseServerInput(form.joinServer)
  if (!parsed.ok) return
  const fromInvite = parsed.invitePassword && !form.password
  if (fromInvite) form.password = parsed.invitePassword
  if (parsed.hasQuery) {
    form.joinServer = parsed.url
    inviteNotice.value = fromInvite
      ? '已从邀请链接识别服务器地址，并自动填入房间密码'
      : '已从邀请链接识别服务器地址'
  }
}

const submit = () => {
  if (props.joining) return
  inlineError.value = ''
  const isMine = mode.value === 'mine'
  const raw = isMine ? form.mineServer : form.joinServer
  if (!isMine && !raw) {
    inlineError.value = '请填写朋友的服务器地址，或粘贴对方发来的邀请链接'
    joinAdvanced.value = true
    return
  }
  const parsed = parseServerInput(raw)
  if (!parsed.ok) {
    inlineError.value = parsed.error
    if (!isMine) joinAdvanced.value = true
    return
  }
  if (isMine) form.mineServer = parsed.url
  else form.joinServer = parsed.url
  emit('connect', {
    serverUrl: parsed.url,
    name: form.name.trim() || '游客',
    password: form.password,
    mine: isMine
  })
}

watch(mode, () => resetProbe())

onMounted(() => {
  if (savedRemote) void runProbe()
})
</script>

<template>
  <div id="onboarding" class="onboarding">
    <section class="onb-left">
      <div class="onb-brand">
        <span class="onb-mark"><img :src="`${baseUrl}musicparty-logo.png`" alt="MusicParty" /></span>
        <div class="onb-brand-text">
          <span class="onb-brand-name">MUSIC PARTY</span>
          <span class="onb-brand-sub">DESKTOP · 一起听歌的房间</span>
        </div>
      </div>

      <div class="onb-copy">
        <p class="onb-kicker">WELCOME · 第一次使用</p>
        <h1 class="onb-title">
          把这一刻的音乐，<br />
          一起听。
        </h1>
        <p class="onb-sub">
          进入自己的「我的房间」，或加入朋友正在听歌的房间：所有人同步播放同一首歌，
          实时点歌、聊天与切歌。服务器地址只保存在这台电脑上。
        </p>
      </div>

      <ol class="onb-steps">
        <li>
          <span class="onb-step-num">01</span>
          <span class="onb-step-copy">
            <strong>进入我的房间</strong>
            <span>启动本机服务后，用「我的房间」进入自己的房间。</span>
          </span>
        </li>
        <li>
          <span class="onb-step-num">02</span>
          <span class="onb-step-copy">
            <strong>或加入朋友的房间</strong>
            <span>填写朋友给你的服务器地址与房间密码。</span>
          </span>
        </li>
        <li>
          <span class="onb-step-num">03</span>
          <span class="onb-step-copy">
            <strong>一起点歌与同步播放</strong>
            <span>播放、切歌与聊天对房间内所有人生效，操作前打个招呼。</span>
          </span>
        </li>
      </ol>

      <p class="onb-foot">
        还没有本地服务？在「设置 → 服务与连接」里启动；也可以向发邀请链接给你的朋友获取地址。
      </p>
    </section>

    <section class="onb-right">
      <form class="onb-card" novalidate @submit.prevent="submit">
        <div class="onb-card-head">
          <div class="onb-card-title">
            <span class="label">连接房间 · CONNECT</span>
            <h2>进入一个房间</h2>
          </div>
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

        <div class="onb-tabs" role="tablist" aria-label="连接方式">
          <button
            id="onb-tab-mine"
            type="button"
            class="onb-tab"
            :class="{ active: mode === 'mine' }"
            role="tab"
            :aria-selected="mode === 'mine' ? 'true' : 'false'"
            @click="switchMode('mine')"
          >
            <span class="onb-tab-name"><Server :size="14" :stroke-width="1.9" /> 我的房间</span>
            <span class="onb-tab-sub">自己的房间 · 本机服务</span>
          </button>
          <button
            id="onb-tab-join"
            type="button"
            class="onb-tab"
            :class="{ active: mode === 'join' }"
            role="tab"
            :aria-selected="mode === 'join' ? 'true' : 'false'"
            @click="switchMode('join')"
          >
            <span class="onb-tab-name"><Users :size="14" :stroke-width="1.9" /> 加入房间</span>
            <span class="onb-tab-sub">朋友的服务器 · 房间密码</span>
          </button>
        </div>

        <label class="onb-field">
          <span class="onb-label"><UserRound :size="12" /> 昵称</span>
          <input
            id="onb-nickname"
            v-model="form.name"
            class="text-field onb-input"
            name="nickname"
            maxlength="32"
            autocomplete="nickname"
            placeholder="其他人在房间里看到的名字（默认：游客）"
            @keydown.enter.prevent="submit"
          />
          <span class="onb-note">「游客」可以浏览；点歌、聊天或控制播放前，请填写自己的昵称。</span>
        </label>

        <label class="onb-field">
          <span class="onb-label"><ShieldCheck :size="12" /> 房间密码</span>
          <input
            id="onb-password"
            v-model="form.password"
            class="text-field onb-input"
            name="room-password"
            type="password"
            autocomplete="current-password"
            :placeholder="mode === 'mine' ? '你的房间没有密码时留空' : '朋友房间的密码，没有密码时留空'"
            :aria-invalid="passwordInvalid ? 'true' : 'false'"
            :aria-describedby="passwordInvalid ? 'onb-error' : undefined"
            @keydown.enter.prevent="submit"
          />
        </label>

        <template v-if="mode === 'mine'">
          <div class="onb-room">
            <div class="onb-room-head">
              <span class="label">我的房间 · MY ROOM</span>
              <span class="onb-room-tag">{{ mineIsLocal ? '本机服务' : '已保存的服务器' }}</span>
            </div>
            <div class="onb-room-address">
              <Server :size="13" :stroke-width="1.8" />
              <code class="onb-room-host">{{ mineHost }}</code>
              <button type="button" class="text-btn onb-room-edit" @click="mineEditing = !mineEditing">
                {{ mineEditing ? '收起' : '更改' }}
              </button>
            </div>

            <div v-if="mineEditing" class="onb-room-edit-fields">
              <input
                id="onb-mine-server"
                v-model="form.mineServer"
                class="text-field onb-input"
                spellcheck="false"
                placeholder="http://127.0.0.1:8080 或你自己的服务器地址"
                @input="onMineServerInput"
                @blur="mineEditing = false"
                @keydown.enter.prevent="submit"
              />
              <div class="onb-probe-row">
                <button type="button" class="btn-ghost onb-check" :disabled="checking" @click="runProbe">
                  <Loader2 v-if="checking" class="onb-spin" :size="13" :stroke-width="2" />
                  <Wifi v-else :size="13" :stroke-width="1.8" />
                  {{ checking ? '检测中…' : '检测连接' }}
                </button>
                <button type="button" class="text-btn onb-reset" @click="useDefaultMineServer">
                  恢复本机默认
                </button>
              </div>
            </div>

            <p class="onb-room-hint">
              在你自己的电脑上运行 MusicParty 本地服务后，用这个地址进入自己的房间。
              服务还没启动？打开「设置 → 服务与连接」启动本地服务；也可以切到「加入房间」连接朋友的服务器。
            </p>

            <div class="onb-probe-row">
              <span class="onb-probe-result" :class="probe.status" role="status" aria-live="polite">
                <template v-if="probe.status === 'ok'">
                  <CheckCircle2 :size="13" :stroke-width="2" /> {{ probe.message }}
                </template>
                <template v-else-if="probe.status === 'fail'">
                  <AlertCircle :size="13" :stroke-width="2" /> {{ probe.message }}
                </template>
                <template v-else-if="probe.status === 'checking'">{{ probe.message }}</template>
                <template v-else>
                  本地服务未启动时无法进入「我的房间」；
                  <button type="button" class="text-btn onb-inline-link" @click="emit('settings')">打开设置</button>
                </template>
              </span>
            </div>
            <p v-if="probe.note && probe.status === 'ok'" class="onb-probe-note">{{ probe.note }}</p>
          </div>

          <button id="onb-submit-mine" type="submit" class="btn-primary onb-submit" :disabled="joining">
            <Loader2 v-if="joining" class="onb-spin" :size="15" :stroke-width="2.2" />
            {{ joining ? '正在连接…' : '进入我的房间' }}
            <DoorOpen v-if="!joining" :size="15" :stroke-width="2.2" />
          </button>
        </template>

        <template v-else>
          <p class="onb-join-hint">输入朋友给你的服务器地址或邀请链接，以及房间密码即可加入。</p>

          <button
            type="button"
            class="onb-server-row"
            :aria-expanded="joinAdvanced ? 'true' : 'false'"
            aria-controls="onb-join-advanced"
            @click="joinAdvanced = !joinAdvanced"
          >
            <Server :size="13" :stroke-width="1.8" />
            <span class="onb-server-key">服务器地址 · 高级</span>
            <span class="onb-server-value">{{ targetHost }}</span>
            <span class="onb-server-action">{{ joinAdvanced ? '收起' : '展开' }}</span>
          </button>

          <div v-if="joinAdvanced" id="onb-join-advanced" class="onb-advanced">
            <label class="onb-field">
              <span class="onb-label"><Link2 :size="12" /> 服务器地址 / 邀请链接</span>
              <div class="onb-server-input">
                <input
                  id="onb-join-server"
                  v-model="form.joinServer"
                  class="text-field onb-input"
                  spellcheck="false"
                  placeholder="https://your-server.example.com 或 http://127.0.0.1:8080"
                  @blur="onJoinServerBlur"
                  @input="onJoinServerInput"
                  @keydown.enter.prevent="submit"
                />
                <button v-if="savedRemote" type="button" class="text-btn onb-reset" @click="form.joinServer = savedRemote">
                  上次地址
                </button>
              </div>
            </label>
            <p class="onb-advanced-hint">
              可粘贴朋友发来的房间链接，会自动识别服务器地址与密码；服务器地址只保存在本机。
            </p>
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

          <button id="onb-submit-join" type="submit" class="btn-primary onb-submit" :disabled="joining">
            <Loader2 v-if="joining" class="onb-spin" :size="15" :stroke-width="2.2" />
            {{ joining ? '正在加入房间…' : '加入房间' }}
            <ArrowRight v-if="!joining" :size="15" :stroke-width="2.2" />
          </button>
        </template>

        <p v-if="errorText" id="onb-error" class="onb-error" role="alert">
          <AlertCircle :size="14" :stroke-width="2" />
          <span>{{ errorText }}</span>
        </p>

        <div class="onb-links">
          <button id="onb-demo" type="button" class="text-btn onb-link" @click="emit('demo')">
            <Sparkles :size="12" /> 进入演示界面（原创测试音频）
          </button>
          <button id="onb-settings" type="button" class="text-btn onb-link" @click="emit('settings')">
            <Settings :size="12" /> 设置
          </button>
          <button id="onb-clear-data" type="button" class="text-btn onb-link" @click="emit('clear-data')">清除本地数据</button>
        </div>

        <p class="onb-privacy">
          <ShieldCheck :size="11" /> 不收集个人信息 · 服务器地址与昵称仅保存在本机
        </p>
      </form>
    </section>
  </div>
</template>

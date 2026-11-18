<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  ChevronDown,
  ChevronLeft,
  Database,
  FolderOpen,
  PlayCircle,
  Radio,
  Server,
  ShieldCheck,
  Square,
  Trash2,
  Volume2
} from 'lucide-vue-next'
import {
  launcher,
  getConfig,
  setConfig,
  getStatus,
  start,
  stop,
  restart,
  openDataDir,
  pickFile,
  describeServiceState,
  setSecrets,
  clearSecrets,
  ensureLocalAdminPassword,
  revealLocalAdminPassword
} from '../core/launcher-bridge.js'
import { loadSettings, saveSettings, parseServerUrl } from '../core/live/config'
import { live } from '../core/live/state'
import { adminAuth } from '../core/live/admin.js'
import { playback, setLocalVolume, toggleLocalMute } from '../core/playback'
import { APP_PRODUCT_NAME, APP_VERSION, ELECTRON_VERSION, resolveAppVersion } from '../core/version.js'
import { appearance, themeColors, setThemeColor } from '../core/appearance.js'
import { lyricStyle, lyricColors, lyricFonts, setLyricStyle } from '../core/desktop-lyrics-style.js'

const emit = defineEmits(['close', 'saved', 'notify', 'open-admin', 'local-data-cleared', 'server-change', 'clear-data', 'leave-room'])
const updateLyricStyle = patch => { if (!setLyricStyle(patch)) emit('notify', '桌面歌词样式无法保存，请检查本机存储空间。') }
const rgbValue = index => parseInt(lyricStyle.color.slice(1 + index * 2, 3 + index * 2), 16)
const setRgbValue = (index, event) => {
  const value = Math.max(0, Math.min(255, Math.round(Number(event.target.value) || 0)))
  const values = [0, 1, 2].map(rgbValue); values[index] = value
  updateLyricStyle({ color: '#' + values.map(n => n.toString(16).padStart(2, '0')).join('') })
}
const closePreference = ref('ask')
onMounted(async () => { closePreference.value = await window.mpDesktop?.window?.getClosePreference?.() || 'ask' })
const setClosePreference = async (event) => {
  const value = event.target.value
  try { closePreference.value = await window.mpDesktop?.window?.setClosePreference?.(value) || value }
  catch { event.target.value = closePreference.value; emit('notify', '无法保存关闭偏好，请检查本机数据目录权限。') }
}

const savedLiveSettings = loadSettings()
const section = ref('play')
const saveState = ref('')
const advancedOpen = ref(false)
const guideOpen = ref(false)
const choosing = ref('')
/** 展示版本：构建时取 package.json（单一来源），运行时优先 Electron app.getVersion()。 */
const appVersion = ref(APP_VERSION)

const form = reactive({
  volume: playback.volume,
  // 服务器地址由用户/房间管理员提供；默认值仅本地回环，不含任何个人域名。
  serverUrl: savedLiveSettings.serverUrl || 'http://127.0.0.1:8080',
  localPort: '8080',
  baseUrl: 'http://127.0.0.1:8080',
  javaPath: '',
  serverJar: '',
  autoStart: false
})

/* ------------------------------------------------------------------ */
/* 本机管理员密码（D-09）：通过 launcher bridge 设置/生成/查看/清除      */
/* 集成点：desktop-launcher 的 <LauncherStatusPanel> / <LocalAdminSetupDialog> */
/* 组件就绪后可替换本分区内联状态行与本机密码面板；当前按 bridge 契约自实现， */
/* 字段命名以 launcher-bridge.js（services.java/netease/system、resources 嵌套、 */
/* adminPasswordSet/*Set、secretsStorage）为准。                           */
/* ------------------------------------------------------------------ */
const localAdminBusy = ref('')
const localAdminError = ref('')
const localAdminNotice = ref('')
const localAdminPassword = ref('')
const localAdminManual = ref('')
const localAdminClearArmed = ref(false)

/** 本机服务地址判定（仅回环；私网/远程不认为是本机）。 */
const isLoopbackAddress = (value) => {
  const parsed = parseServerUrl(value)
  if (!parsed.ok) return false
  try {
    const host = new URL(parsed.url).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

const runLocalAdminAction = async (name, payload) => {
  const handlers = {
    ensure: ensureLocalAdminPassword,
    reveal: revealLocalAdminPassword,
    set: (patch) => setSecrets(patch),
    clear: (options) => clearSecrets(options)
  }
  const handler = handlers[name]
  localAdminError.value = ''
  localAdminNotice.value = ''
  localAdminBusy.value = name
  try {
    return name === 'ensure' || name === 'reveal' ? await handler() : await handler(payload)
  } catch (error) {
    localAdminError.value = String(error?.message || error)
    return { ok: false, error: localAdminError.value }
  } finally {
    localAdminBusy.value = ''
  }
}

const ensureLocalAdmin = async () => {
  const result = await runLocalAdminAction('ensure')
  if (!result || result.ok !== true) {
    localAdminError.value = result?.error || launcher.error || '生成管理员密码失败'
    return
  }
  if (typeof result.password === 'string' && result.password) {
    localAdminPassword.value = result.password
    localAdminNotice.value = result.generated
      ? '已生成新的本机管理员密码：请立即复制保存（只显示这一次）'
      : '本机管理员密码已设置'
  } else {
    localAdminNotice.value = '本机已有管理员密码（如忘记可点「显示」或重新生成）'
  }
  await getConfig()
}

const revealLocalAdmin = async () => {
  const result = await runLocalAdminAction('reveal')
  if (!result || result.ok !== true) {
    localAdminError.value = result?.error || launcher.error || '读取管理员密码失败'
    return
  }
  if (result.set === false || !result.password) {
    localAdminError.value = '本机管理员密码尚未设置，请先「生成并保存」或手动设置'
    return
  }
  localAdminPassword.value = String(result.password)
  localAdminNotice.value = '已显示本机管理员密码（仅本机可见，请勿截图外传）'
}

const saveLocalAdminManual = async () => {
  const value = String(localAdminManual.value || '').trim()
  if (!value) {
    localAdminError.value = '请输入新的本机管理员密码（不能为空或纯空白）'
    return
  }
  const result = await runLocalAdminAction('set', { adminPassword: value })
  if (!result || result.ok !== true) {
    localAdminError.value = result?.error || launcher.error || '保存本机管理员密码失败'
    return
  }
  localAdminManual.value = ''
  localAdminPassword.value = value
  localAdminNotice.value = '本机管理员密码已更新'
  await getConfig()
}

const clearLocalAdmin = async () => {
  if (!localAdminClearArmed.value) {
    localAdminClearArmed.value = true
    localAdminNotice.value = '再次点击「确认清除」将从本机删除管理员密码；本地服务将需要重新设置后才能启动'
    return
  }
  localAdminClearArmed.value = false
  const result = await runLocalAdminAction('clear', { keys: ['adminPassword'] })
  if (!result || result.ok !== true) {
    localAdminError.value = result?.error || launcher.error || '清除本机管理员密码失败'
    return
  }
  localAdminPassword.value = ''
  localAdminNotice.value = '已清除本机管理员密码（下次启动本地服务前需要重新设置）'
  await getConfig()
}

const copyLocalAdminPassword = async () => {
  if (!localAdminPassword.value) return
  try {
    await navigator.clipboard?.writeText(localAdminPassword.value)
    localAdminNotice.value = '本机管理员密码已复制到剪贴板'
  } catch {
    localAdminError.value = '剪贴板不可用，请手动选择复制'
  }
}

/** 本机管理员密码是否已设置（getConfig 脱敏后的布尔）。 */
const adminPasswordSet = computed(() => launcher.config?.adminPasswordSet === true)
const secretsStorage = computed(() => launcher.config?.secretsStorage || launcher.status?.secretsStorage || {})
const secretsStorageLabel = computed(() => {
  const mode = String(secretsStorage.value?.mode || '')
  if (mode === 'safeStorage') return '系统加密存储'
  if (mode === 'file') return '受限权限文件'
  if (mode === 'none') return '未存储'
  return '状态未知'
})

const groups = [
  { id: 'play', label: '播放', icon: PlayCircle },
  { id: 'service', label: '服务与连接', icon: Server },
  { id: 'sources', label: '音源账号', icon: Radio },
  { id: 'room', label: '房间与权限', icon: ShieldCheck },
  { id: 'data', label: '本地数据', icon: Database }
]

const current = computed(() => groups.find((g) => g.id === section.value) || groups[0])
/** 只有真实可保存的分区才显示「保存更改」。 */
const showSave = computed(() => section.value === 'play' || section.value === 'service')
const headerHint = computed(() => {
  if (section.value === 'play') return '本机音量/静音保存在本机，立即生效'
  if (section.value === 'service') return '服务与连接配置保存在本机'
  if (section.value === 'data') return '只清本机数据；服务器上的房间内容不受影响'
  return '只读说明 · 由房间管理员在管理终端配置'
})
/** 未接入任何代码的播放选项：统一禁用并标注「暂未支持」，不再假装可保存。 */
const unsupportedPlayOptions = [
  { name: '淡入淡出', desc: '切歌时交叉淡化（暂未实现）' },
  { name: '无缝切歌', desc: '预载下一首避免空隙（暂未实现）' },
  { name: '歌词滚动设置', desc: '自动高亮/居中策略（暂未实现）' },
  { name: '播放顺序', desc: '队列顺序 / 公平随机（服务端管理员配置）' },
  { name: '记住播放位置', desc: '重启后继续上次进度（暂未实现）' },
  { name: '后台播放', desc: '最小化时保持播放（当前由系统托盘行为决定）' },
  { name: '降低动效', desc: '减少过渡动画（跟随系统 reduced-motion）' }
]

/* ------------------------------------------------------------------ */
/* 本地数据（localStorage / 目录说明）                                 */
/* ------------------------------------------------------------------ */

/** 只清 App 自己的 localStorage 键；不碰其他目录、不碰管理员会话（只在内存）。 */
const LOCAL_DATA_KEYS = [
  { key: 'mp.desktop.settings', label: '服务器地址 / 昵称', desc: '加入房间时保存的连接信息' },
  { key: 'mp.room.mine.v1', label: '「我的房间」地址', desc: '你自己配置的房间服务器地址' },
  { key: 'mp.desktop.tutorial.v1', label: '新手引导记忆', desc: '清除后下次进入房间会重新显示引导' },
  { key: 'mp.desktop.playlist-bindings.v1', label: '本机用户歌单绑定', desc: '仅保存在本机，不影响其他成员' }
]
const localPresence = reactive({ 'mp.desktop.settings': false, 'mp.room.mine.v1': false, 'mp.desktop.tutorial.v1': false,
  'mp.desktop.playlist-bindings.v1': false, 'mp.desktop.token': false })

const refreshLocalPresence = () => {
  for (const key of Object.keys(localPresence)) {
    try {
      localPresence[key] = localStorage.getItem(key) != null
    } catch {
      localPresence[key] = false
    }
  }
}

const presentCount = computed(() => LOCAL_DATA_KEYS.filter((item) => localPresence[item.key]).length)

/* ------------------------------------------------------------------ */
/* 本地服务状态（资源探测驱动，未内置 ≠ 异常）                          */
/* 显示契约：Java 版本/兼容性、MusicParty ready、网易云 API 各自独立状态； */
/* 不再用一个总绿灯掩盖“Java 活着但服务没就绪 / 网易云 API 缺失”。          */
/* ------------------------------------------------------------------ */

const javaService = computed(() => launcher.status.services?.java || {})
const neteaseService = computed(() => launcher.status.services?.netease || {})
const systemService = computed(() => launcher.status.services?.system || {})
const serviceState = computed(() => describeServiceState(launcher.status))
/** 兼容 launcher bridge 新旧扁平/嵌套 resources（desktop-launcher v2 为嵌套结构）。 */
const resources = computed(() => {
  const raw = serviceState.value.resources || {}
  const java = raw.java || {}
  const jar = raw.serverJar || {}
  const netease = raw.neteaseApi || {}
  return {
    javaFound: Boolean(java.found ?? raw.javaFound),
    javaPath: java.path || raw.javaPath || '',
    javaSource: java.source || raw.javaSource || 'none',
    javaVersion: java.version || '',
    javaCompatible: java.compatible !== false,
    jarFound: Boolean(jar.found ?? raw.jarFound),
    jarPath: jar.path || raw.jarPath || '',
    jarSource: jar.source || raw.jarSource || 'none',
    neteaseFound: Boolean(netease.found ?? raw.neteaseFound),
    neteasePath: netease.path || raw.neteasePath || '',
    neteaseSource: netease.source || raw.neteaseSource || 'none',
    neteaseBaseUrl: netease.baseUrl || '',
    ready: Boolean(raw.ready)
  }
})
// The API child may outlive Java (e.g. after a Java crash). It still belongs to us
// and must remain stoppable even when the aggregate Java-running flag is false.
const running = computed(() => Boolean(launcher.status.running || javaService.value.running || neteaseService.value.running))
const ready = computed(() => Boolean(resources.value.ready || (resources.value.javaFound && resources.value.jarFound)))

/** 服务状态 → 中文标签（launcher v2 state 枚举，兼容旧 running/healthy）。 */
const SERVICE_STATE_LABELS = {
  stopped: '未运行',
  probing: '探测中',
  incompatible: '版本不兼容',
  missing: '缺失',
  starting: '启动中',
  ready: '就绪',
  degraded: '未就绪',
  error: '错误',
  disabled: '未启用',
  external: '外部地址',
  unhealthy: '不健康',
  ok: '正常'
}
const describeService = (service) => {
  const value = service && typeof service === 'object' ? service : {}
  const state =
    typeof value.state === 'string'
      ? value.state
      : value.running
        ? value.healthy
          ? 'ready'
          : 'degraded'
        : 'stopped'
  return {
    state,
    label: SERVICE_STATE_LABELS[state] || state,
    ok: state === 'ready' || state === 'ok',
    warn: state === 'degraded' || state === 'unhealthy' || state === 'starting' || state === 'probing',
    version: value.version || '',
    lastError: value.lastError || '',
    compatible: value.compatible !== false,
    pid: value.pid ?? null
  }
}
const javaStatus = computed(() => describeService(javaService.value))
const musicPartyStatus = computed(() => {
  const status = describeService(javaService.value)
  // services.java.state==='ready' 表示 /api/config 真正就绪（Java 进程活 ≠ 服务就绪）。
  return { ...status, ok: status.state === 'ready', label: status.state === 'ready' ? '已就绪' : status.label }
})
const neteaseStatus = computed(() => {
  const status = describeService(neteaseService.value)
  const mode = String(neteaseService.value?.mode || '')
  const label = status.state === 'ready' ? '就绪' : status.state === 'disabled' && mode === 'external' ? '外部地址' : status.label
  return { ...status, label }
})
const systemStatus = computed(() => {
  const value = systemService.value || {}
  const state = typeof value.state === 'string' ? value.state : 'stopped'
  return { state, label: SERVICE_STATE_LABELS[state] || state, ok: state === 'ok', lastError: value.lastError || '' }
})
const serviceStatusRows = computed(() => [
  {
    key: 'java',
    name: 'Java 运行时',
    label: javaStatus.value.label,
    ok: javaStatus.value.ok,
    warn: !javaStatus.value.compatible || javaStatus.value.state === 'incompatible',
    detail: javaStatus.value.version
      ? `Java ${javaStatus.value.version}${javaStatus.value.compatible ? '（兼容 21+）' : '（需要 21+）'}`
      : javaStatus.value.compatible
        ? '版本未知'
        : '需要 Java 21+',
    error: javaStatus.value.lastError
  },
  {
    key: 'musicparty',
    name: 'MusicParty 服务',
    label: musicPartyStatus.value.label,
    ok: musicPartyStatus.value.ok,
    warn: musicPartyStatus.value.warn,
    detail: launcher.status.baseUrl || launcher.status.healthUrl || '等待 /api/config 就绪',
    error: javaStatus.value.lastError
  },
  {
    key: 'netease',
    name: '网易云 API',
    label: neteaseStatus.value.label,
    ok: neteaseStatus.value.ok,
    warn: neteaseStatus.value.warn,
    detail: neteaseService.value?.baseUrl || resources.value.neteaseBaseUrl || '可选组件；缺失不影响 Java 服务与 B 站音源',
    error: neteaseStatus.value.lastError
  },
  {
    key: 'system',
    name: '启动器系统状态',
    label: systemStatus.value.label,
    ok: systemStatus.value.ok,
    warn: systemStatus.value.label === '未运行',
    detail: systemStatus.value.lastError || '配置 / 日志 / 存储检查'
  }
])

/** 默认监听地址提示：0.0.0.0/:: 代表对局域网/公网开放，需要提醒。 */
const listenHint = computed(() => {
  const ip = String(launcher.config?.serverIp || '127.0.0.1')
  const port = Number(launcher.config?.serverPort || form.localPort || 8080)
  const exposed = ip === '0.0.0.0' || ip === '::' || ip === ''
  return {
    ip: ip || '127.0.0.1',
    port,
    label: `${ip || '127.0.0.1'}:${port}`,
    exposed,
    text: exposed
      ? `监听 ${ip || '0.0.0.0'}:${port} · 对局域网/公网开放，请务必设置强管理员密码并只在可信网络使用`
      : `监听 ${ip || '127.0.0.1'}:${port} · 仅本机可访问（默认回环，公网开放需显式配置）`
  }
})

/** 当前会话 base 与“编辑中的下次连接地址”分开显示（D-16）。 */
const sessionBaseLabel = computed(() => live.sessionBase || '未连接（当前没有活动会话）')
const addressDiffers = computed(() => {
  if (!live.joined || !live.sessionBase) return false
  const parsed = parseServerUrl(form.serverUrl)
  return parsed.ok && parsed.url !== live.sessionBase
})

const cardTitle = computed(() => {
  switch (serviceState.value.kind) {
    case 'running':
      return '本地服务运行中'
    case 'ready':
      return '本地服务已配置，可以启动'
    case 'misconfigured':
      return '本地服务路径配置无效'
    case 'partial':
      return '本地服务资源不完整'
    case 'unsupported':
      return '当前环境不支持本地服务管理'
    case 'starting':
      return '本地服务启动中'
    case 'degraded':
      return '本地服务未就绪（Java 进程活着但 /api/config 未就绪）'
    case 'incompatible':
      return 'Java 版本不兼容（需要 21+）'
    case 'error':
      return '本地服务启动失败'
    default:
      return '当前版本未内置本地服务'
  }
})

const cardDesc = computed(() => {
  switch (serviceState.value.kind) {
    case 'running':
      return `${launcher.status.baseUrl || 'http://127.0.0.1:8080'} · PID ${javaService.value.pid || '—'} · 本机房间已就绪；连接远程房间不受影响。`
    case 'ready':
      return '已找到兼容的 Java 运行时与 server.jar。启动后可在本机创建房间；连接远程房间仍可随时使用。'
    case 'misconfigured':
      return `已配置的路径找不到文件（${serviceState.value.missingText}）。可以重新选择文件，或直接连接远程房间。`
    case 'partial':
      return `内置资源缺少 ${serviceState.value.missingLabels.join(' 与 ')}，暂时无法启动本地房间。连接远程房间即可使用全部在线功能。`
    case 'unsupported':
      return '请在 Music Party 桌面端中使用本地服务；浏览器预览不支持启动本地进程。'
    case 'starting':
      return 'Java 进程已拉起，正在等待 MusicParty 的 /api/config 就绪；下方「MusicParty 服务」会单独显示就绪状态。'
    case 'degraded':
      return `Java 进程存在但服务未就绪${javaStatus.value.lastError ? `：${javaStatus.value.lastError}` : '（请查看日志）'}。网易云 API 缺失/不健康只影响对应音源，不影响 Java 服务。`
    case 'incompatible':
      return `检测到的 Java 版本不兼容（${javaStatus.value.version || '版本未知'}）。需要 Java 21+；可在高级设置中选择兼容的 java.exe。`
    case 'error':
      return javaStatus.value.lastError || launcher.status.lastError || '启动失败，请查看日志。'
    default:
      return '公共版安装包不包含 Java 运行时与服务端文件，本地房间暂不可用。连接远程房间即可使用全部在线功能；需要自建房间时，可按「启用文档」补充资源。'
  }
})

const startDisabledReason = computed(() => {
  if (!launcher.available) return '当前环境不支持本地服务'
  if (running.value) return ''
  if (launcher.busy) return '操作进行中，请稍候'
  if (javaStatus.value.state === 'incompatible' || !javaStatus.value.compatible) {
    return 'Java 版本不兼容（需要 21+），请先在高级设置中选择兼容的 Java'
  }
  if (!ready.value) return `${serviceState.value.missingText || '本地服务资源缺失'}，无法启动；可连接远程房间，或先补充资源`
  return ''
})
const startDisabled = computed(() => Boolean(startDisabledReason.value))

const sourceLabels = {
  bundled: '内置 bin/',
  configured: '自定义路径',
  env: '环境变量',
  system: '系统 PATH',
  none: '未找到'
}

const resourceRows = computed(() => [
  {
    key: 'java',
    name: 'Java 运行时',
    found: Boolean(resources.value.javaFound),
    source: sourceLabels[resources.value.javaSource] || '未找到',
    path: resources.value.javaPath || '',
    version: resources.value.javaVersion || '',
    compatible: resources.value.javaCompatible
  },
  {
    key: 'jar',
    name: 'server.jar',
    found: Boolean(resources.value.jarFound),
    source: sourceLabels[resources.value.jarSource] || '未找到',
    path: resources.value.jarPath || '',
    version: ''
  },
  {
    key: 'netease',
    name: '网易云 API（可选）',
    found: Boolean(resources.value.neteaseFound),
    source: sourceLabels[resources.value.neteaseSource] || '未找到',
    path: resources.value.neteasePath || '',
    version: ''
  }
])

const failureText = computed(() => launcher.error || launcher.status.lastError || '')
/** 资源缺失是“公共版正常状态”，不当作失败展示；只有真正尝试启动后的错误才提示。 */
const showFailure = computed(() => {
  if (!failureText.value) return false
  if (['not-bundled', 'partial', 'misconfigured', 'unsupported'].includes(serviceState.value.kind)) {
    return false
  }
  return true
})
const failureLogs = computed(() => {
  const tail = Array.isArray(launcher.status.logTail) ? launcher.status.logTail : []
  const source = tail.length > 0 ? tail : launcher.logs.slice(-3)
  return source.slice(-3)
})

const shortPath = (value) => {
  const text = String(value || '')
  if (!text) return '—'
  const parts = text.split(/[\\/]+/)
  if (parts.length <= 2) return text
  return `…\\${parts.slice(-2).join('\\')}`
}

/* ------------------------------------------------------------------ */
/* 音源账号：读服务器状态（不显示假数据，不提供普通用户可改入口）       */
/* ------------------------------------------------------------------ */

const neteaseCookieConfigured = computed(
  () => live.joined ? live.config?.neteaseCookieConfigured ?? null : null
)

const neteaseStatusLabel = computed(() => {
  if (!live.joined) return '未加入房间'
  if (neteaseCookieConfigured.value == null) return '管理员可查看'
  return neteaseCookieConfigured.value ? '已配置' : '未配置'
})

const neteaseStatusDesc = computed(() => {
  if (!live.joined) return '加入房间后读取服务器音源配置；当前无法确认 Cookie 状态'
  if (neteaseCookieConfigured.value == null) return '此服务端不向普通成员广播凭据状态；请在管理员终端查看'
  if (neteaseCookieConfigured.value) return '服务器已配置网易云 Cookie'
  return '服务器未配置网易云 Cookie，网易云歌曲可能无法播放'
})

const neteaseEnabledLabel = computed(() => {
  if (!live.joined) return '未加入房间'
  return live.config && live.config.neteaseEnabled ? '已启用' : '已停用'
})

/* ------------------------------------------------------------------ */
/* 房间与权限：全部是管理员能力，普通用户只读 + 认证入口                */
/* ------------------------------------------------------------------ */

const adminVerified = computed(() => Boolean(adminAuth.verified))
const roomServerLabel = computed(() => (live.joined ? live.sessionBase || live.server || '已加入' : '未加入房间'))
const roomConnectedLabel = computed(() => {
  if (!live.joined) return '—'
  return live.connected ? '已连接' : live.reconnecting ? '重连中' : '已断开'
})

/* ------------------------------------------------------------------ */
/* 数据加载 / 保存                                                     */
/* ------------------------------------------------------------------ */

const loadLauncherState = async () => {
  const config = await getConfig()
  form.localPort = String(config.serverPort || form.localPort)
  form.baseUrl = config.baseUrl || form.baseUrl
  form.javaPath = config.javaPath || ''
  form.serverJar = config.serverJar || ''
  form.autoStart = Boolean(config.autoStart)
  // 服务器地址属于用户本地设置（live config），与启动器配置分开保存。
  const saved = loadSettings()
  form.serverUrl = saved.serverUrl
  await getStatus()
}

onMounted(() => {
  refreshLocalPresence()
  void loadLauncherState()
  // 运行时以 Electron app.getVersion() 为准（打包/安装包），浏览器预览回退构建时版本。
  void resolveAppVersion().then((version) => {
    if (version) appVersion.value = version
  })
})

// 进入「服务与连接」时重新读取配置与资源状态（例如刚在控制台选过文件）。
// 进入「本地数据」时重新读取 localStorage 键是否存在（可能在别处刚被写入/清除）。
watch(section, (value) => {
  if (value === 'service') void loadLauncherState()
  if (value === 'data') refreshLocalPresence()
})

/**
 * 保存“服务与连接”分区。
 *
 * D-02：地址先用 parseServerUrl 严格校验，无效直接报错（不静默回退 localhost）。
 * D-16：区分三种情况并给出明确状态：
 *  1) 未连接：只保存“下次连接地址”，不触发重连；
 *  2) 已连接且新 base 与当前会话 base 相同：只保存；
 *  3) 已连接且 base 改变：触发 App.vue 的原子切换（退出旧 WS/清 admin/in-flight/歌词/音频，
 *     再切换并可选自动重连）——绝不出现 HTTP 去 B、WS 留 A。
 */
const saveServiceConfig = async () => {
  const rawUrl = String(form.serverUrl || '').trim()
  const parsed = parseServerUrl(rawUrl)
  if (!parsed.ok) {
    saveState.value = ''
    emit('notify', `服务器地址无效：${parsed.error}`)
    return false
  }
  const targetBase = parsed.url
  const currentBase = live.sessionBase || ''
  const wasJoined = Boolean(live.joined && currentBase)
  const switching = wasJoined && targetBase !== currentBase

  // 先保存启动器配置（与本机服务相关；失败则不改变任何连接状态）。
  const ok = await setConfig({
    serverPort: Number(form.localPort) || 8080,
    baseUrl: form.baseUrl,
    javaPath: form.javaPath,
    serverJar: form.serverJar,
    autoStart: Boolean(form.autoStart)
  })
  if (!ok) {
    emit('notify', `保存失败：${launcher.error || '未知错误'}`)
    return false
  }
  form.serverUrl = targetBase

  if (switching) {
    // 交给 App.vue 执行事务：teardown 旧会话 → 保存新地址 → 可选自动重连。
    saveState.value = '已应用并切换'
    emit('notify', '服务器地址已修改：正在原子切换（先退出当前房间，再按新地址重连）')
    emit('server-change', { url: targetBase, previousBase: currentBase, wasJoined: true })
    await getStatus()
    return true
  }

  const saved = saveSettings({ serverUrl: targetBase, mode: 'remote' })
  form.serverUrl = saved.serverUrl
  saveState.value = wasJoined ? '仅保存（当前会话仍用原地址）' : '仅保存（下次连接生效）'
  emit(
    'notify',
    wasJoined
      ? '服务器地址已保存；当前会话仍连接原服务器，重新加入房间后生效'
      : '服务器地址已保存，下次加入房间时生效'
  )
  await getStatus()
  return true
}

const toggleStart = async () => {
  if (launcher.busy) return
  if (!running.value && startDisabled.value) {
    emit('notify', startDisabledReason.value)
    return
  }
  const wasRunning = running.value
  const ok = wasRunning ? await stop() : await start()
  if (!ok && launcher.status && launcher.status.needsAdminPassword) {
    // D-09：首次使用本地服务必须先设置管理员密码，而不是用空密码启动。
    localAdminError.value = '首次使用本地服务需要先设置管理员密码（见本分区「本机管理员密码」）'
    emit('notify', '首次使用本地服务需要先设置管理员密码：可在下方「本机管理员密码」一键生成并保存')
    await getStatus()
    return
  }
  emit('notify', ok ? (wasRunning ? '本地服务已停止' : '本地服务已启动') : `操作失败：${launcher.error || '未知错误'}`)
  await getStatus()
}

const restartServices = async () => {
  if (launcher.busy || !running.value) return
  const ok = await restart()
  emit('notify', ok ? '本地服务已重启' : `重启失败：${launcher.error || '未知错误'}`)
  await getStatus()
}

const openUserData = async () => {
  const ok = await openDataDir()
  if (!ok) emit('notify', launcher.error || '打开数据目录失败')
}

const chooseResource = async (kind) => {
  if (choosing.value || launcher.busy) return
  choosing.value = kind
  try {
    const picked = await pickFile(kind)
    if (picked.canceled) return
    if (!picked.ok) {
      emit('notify', `无法选择文件：${picked.error || '未知错误'}`)
      return
    }
    const patch = kind === 'java' ? { javaPath: picked.path } : { serverJar: picked.path }
    Object.assign(form, patch)
    const saved = await setConfig(patch)
    await getStatus()
    emit(
      'notify',
      saved
        ? kind === 'java'
          ? `已选择 Java：${shortPath(picked.path)}`
          : `已选择 server.jar：${shortPath(picked.path)}`
        : `保存路径失败：${launcher.error || '未知错误'}`
    )
  } finally {
    choosing.value = ''
  }
}

const save = async () => {
  if (section.value === 'service') {
    const ok = await saveServiceConfig()
    if (!ok) return
    emit('saved')
    setTimeout(() => (saveState.value = ''), 2600)
    return
  }
  if (section.value === 'sources') {
    emit('notify', '音源配置由房间管理员在管理后台维护，客户端暂不可修改')
    return
  }
  if (section.value === 'play') {
    // 只保存本机音量（localStorage）：不影响系统音量，也不影响房间里其他人的音量。
    setLocalVolume(form.volume)
  }
  saveState.value = '已保存'
  emit('saved')
  setTimeout(() => (saveState.value = ''), 1600)
}
</script>

<template>
  <div class="settings">
    <aside class="settings-rail">
      <div class="settings-brand">
        <span class="label">设置 · SETTINGS</span>
        <span class="settings-version">{{ APP_PRODUCT_NAME }} Desktop · {{ appVersion }}</span>
      </div>

      <button
        v-for="g in groups"
        :key="g.id"
        class="settings-nav-item"
        :class="{ active: section === g.id }"
        @click="section = g.id"
      >
        <component :is="g.icon" :size="15" :stroke-width="1.7" />
        {{ g.label }}
      </button>

      <div class="settings-rail-foot">
        <button class="btn-ghost" @click="emit('close')">
          <ChevronLeft :size="13" :stroke-width="1.9" />
          返回应用
        </button>
      </div>
    </aside>

    <div class="settings-content">
      <div class="settings-head">
        <div class="settings-title">
          <h2>{{ current.label }}</h2>
          <span class="label">{{ headerHint }}</span>
        </div>
        <span v-if="saveState" class="saved-flag">{{ saveState }}</span>
        <button v-if="showSave" class="btn-primary" @click="save">保存更改</button>
      </div>

      <div class="settings-body">
        <div class="settings-form">
        <template v-if="section === 'play'">
          <div class="setting-row" id="appearance-themes"><div class="setting-info"><span class="setting-name">主题颜色</span><span class="setting-desc">选择强调色；与深浅色模式分别保存，立即生效。</span></div><div class="theme-choice"><button v-for="theme in themeColors" :key="theme.id" type="button" :aria-pressed="appearance.color === theme.id" @click="setThemeColor(theme.id)"><i :style="{background:theme.color}"></i>{{ theme.label }}</button></div></div>
          <div class="setting-row lyrics-style-row">
            <div class="setting-info"><span class="setting-name">桌面歌词样式</span><span class="setting-desc">仅影响本机桌面歌词，修改立即生效并保存在本机；字体不可用时自动回退。</span></div>
            <div class="lyrics-style-controls">
              <div class="theme-choice"><button v-for="color in lyricColors" :key="color.value" type="button" :aria-pressed="lyricStyle.color === color.value" @click="updateLyricStyle({color:color.value})"><i :style="{background:color.value}"></i>{{ color.label }}</button></div>
              <div class="lyrics-custom"><label>自定义颜色 <input type="color" :value="lyricStyle.color" aria-label="桌面歌词自定义颜色" @input="updateLyricStyle({color:$event.target.value})" /></label><label v-for="(channel, i) in ['R','G','B']" :key="channel">{{ channel }} <input type="number" min="0" max="255" :value="rgbValue(i)" :aria-label="'歌词颜色 ' + channel" @change="setRgbValue(i, $event)" /></label></div>
              <label class="lyrics-font">字体 <select :value="lyricStyle.font" @change="updateLyricStyle({font:$event.target.value})"><option v-for="font in lyricFonts" :key="font.id" :value="font.id">{{ font.label }}</option></select></label>
              <div class="lyrics-custom"><label><input type="checkbox" :checked="lyricStyle.fill" @change="updateLyricStyle({fill:$event.target.checked})" /> 颜色覆盖</label><label><input type="checkbox" :checked="lyricStyle.wave" @change="updateLyricStyle({wave:$event.target.checked})" /> 字符波浪</label></div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">本机音量</span>
              <span class="setting-desc">只影响本机 APP 播放音量；不修改系统音量，也不同步到房间里其他成员（自动保存在本机）</span>
            </div>
            <div class="range-wrap">
              <input v-model.number="form.volume" class="range" type="range" min="0" max="100" />
              <span class="range-value">{{ form.volume }}%</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">本机静音</span>
              <span class="setting-desc">短按空格只静音本机；按住空格 1 秒可暂停或恢复房间。</span>
            </div>
            <button class="switch" :class="{ on: playback.muted }" @click="toggleLocalMute()">
              <i></i>
            </button>
          </div>

          <section class="unsupported-panel">
            <span class="label">暂未支持 · COMING LATER</span>
            <p class="unsupported-hint">
              以下播放选项尚未接入任何代码或服务端能力，因此只做说明、不可开关；不会再承诺这些选项已经生效。
            </p>
            <div v-for="item in unsupportedPlayOptions" :key="item.name" class="setting-row disabled-row">
              <div class="setting-info">
                <span class="setting-name">{{ item.name }}</span>
                <span class="setting-desc">{{ item.desc }}</span>
              </div>
              <span class="status-pill">暂未支持</span>
            </div>
          </section>
        </template>

        <template v-else-if="section === 'service'">
          <!-- 普通用户视图：远程连接 + 本地服务状态卡（不展示路径/端口等开发项） -->
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">连接模式</span>
              <span class="setting-desc">公共版以远程房间方式使用，无需在本机运行任何服务</span>
            </div>
            <span class="status-pill">连接远程房间</span>
          </div>

          <!-- D-16：当前会话 base 与“编辑中的下次连接地址”分开显示，避免误以为已切换。 -->
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">当前会话服务器（已生效）</span>
              <span class="setting-desc">
                连接时固化、HTTP/WS/媒体/管理请求统一使用；修改下面的地址不会立即改变它
              </span>
            </div>
            <span class="status-pill" :class="{ ok: Boolean(live.sessionBase) }" :title="sessionBaseLabel">
              {{ live.sessionBase ? '已连接' : '未连接' }}
            </span>
            <button v-if="live.joined" class="btn-ghost" type="button" @click="emit('leave-room')">退出当前房间</button>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">会话完整地址</span>
              <span class="setting-desc">含 scheme 与路径前缀（复制房间地址、REST、WebSocket 都用它）</span>
            </div>
            <code class="data-path" style="max-width: 420px; overflow: auto">{{ sessionBaseLabel }}</code>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">服务器地址（下次连接）</span>
              <span class="setting-desc">
                由房间管理员提供；裸域名默认 HTTPS，本机/局域网默认 HTTP，支持路径前缀。
                已连接时修改并保存会先断开当前房间再切换（不会出现 HTTP/WS 分属两个服务器）。
              </span>
            </div>
            <input
              v-model="form.serverUrl"
              class="text-field svc-url"
              placeholder="127.0.0.1:8080 或 https://你的服务器/前缀"
              spellcheck="false"
              autocomplete="off"
            />
          </div>
          <p v-if="addressDiffers" class="svc-hint" style="color: var(--danger)">
            编辑中的地址与当前会话不同：保存后将原子切换（退出当前房间 → 保存 → 可选自动重连）。
          </p>

          <section class="svc-card" :class="`is-${serviceState.kind}`">
            <div class="svc-card-head">
              <span class="label">本地服务 · LOCAL SERVICE</span>
              <span class="status-pill" :class="{ ok: serviceState.kind === 'running' }">
                {{ serviceState.label }}
              </span>
            </div>
            <div class="svc-card-title">{{ cardTitle }}</div>
            <p class="svc-card-desc">{{ cardDesc }}</p>

            <!-- D-04/D-11：Java 运行时 / MusicParty 服务 / 网易云 API / 启动器系统分开显示，不用一个绿灯掩盖。 -->
            <div class="svc-res-list">
              <span class="label">服务状态 · SERVICES</span>
              <div v-for="row in serviceStatusRows" :key="row.key" class="svc-res-row">
                <span class="service-dot" :class="{ idle: !row.ok, warn: row.warn }"></span>
                <span class="svc-res-name">{{ row.name }}</span>
                <span class="svc-res-source">{{ row.detail }}</span>
                <span class="svc-res-path" :title="row.error || ''">{{ row.error || '' }}</span>
                <span class="status-pill" :class="{ ok: row.ok }">{{ row.label }}</span>
              </div>
            </div>

            <p class="svc-hint" :style="listenHint.exposed ? 'color: var(--danger)' : ''">{{ listenHint.text }}</p>
            <p class="svc-hint">
              本机管理员密码：{{ adminPasswordSet ? '已设置' : '未设置（首次启动本地服务前需要设置）' }}
              · 存储方式：{{ secretsStorageLabel }}
              <template v-if="launcher.status.needsAdminPassword"> · 本地服务等待设置管理员密码</template>
            </p>

            <div class="svc-card-actions">
              <button class="btn-ghost" :disabled="launcher.busy || running || startDisabled" :title="startDisabledReason || '启动本地服务'" @click="toggleStart"><PlayCircle :size="13" />启动本地服务</button>
              <button class="btn-ghost" :disabled="launcher.busy || !running" title="停止本应用启动的本地服务" @click="toggleStart"><Square :size="13" />停止本地服务</button>
              <button class="btn-ghost" :disabled="launcher.busy || !running" :title="running ? '重启本地服务' : '本地服务未运行'" @click="restartServices">
                重启
              </button>
              <button class="btn-ghost" @click="guideOpen = !guideOpen">
                <FolderOpen :size="13" />
                {{ guideOpen ? '收起启用文档' : '打开启用文档' }}
              </button>
            </div>
            <p v-if="!running && startDisabledReason" class="svc-hint">{{ startDisabledReason }}</p>

            <div v-if="guideOpen" class="svc-guide">
              <span class="label">启用文档 · HOW TO ENABLE</span>
              <p class="svc-guide-intro">
                面向大众发布的安装包不包含 Java 运行时与服务端文件，因此“未内置”是正常状态；只连接远程房间时无需任何操作。
                需要自建本地房间时，按下面 3 步启用：
              </p>
              <ol class="svc-steps">
                <li>
                  <b>放置服务端文件</b>：把 <code>server.jar</code>（可选 <code>netease-api</code>）放进数据目录下的 <code>bin</code> 文件夹，
                  或在下方「高级设置」中直接选择文件。
                </li>
                <li>
                  <b>准备 Java 运行时</b>：安装 Java 21+，或点击「选择 Java」指定已有的 <code>java.exe</code>。
                </li>
                <li>
                  <b>启动并验证</b>：资源就绪后点击「启动本地服务」，状态变为「运行中」即可加入本机房间。
                </li>
              </ol>
              <div class="svc-guide-actions">
                <button class="btn-ghost" :disabled="choosing === 'jar'" @click="chooseResource('jar')">选择 server.jar</button>
                <button class="btn-ghost" :disabled="choosing === 'java'" @click="chooseResource('java')">选择 Java</button>
                <button class="btn-ghost" @click="openUserData"><FolderOpen :size="13" /> 打开数据目录</button>
              </div>
              <p class="svc-guide-note">
                开发模式还可通过环境变量 <code>MP_SERVER_JAR</code> 或启动器配置指定路径。公共版用户无需这些步骤。
              </p>
            </div>
          </section>

          <!-- D-09：本机管理员密码入口（通过 launcher bridge 的 safeStorage 秘密存储）。 -->
          <section class="svc-card" id="settings-local-admin">
            <div class="svc-card-head">
              <span class="label">本机管理员密码 · LOCAL ADMIN</span>
              <span class="status-pill" :class="{ ok: adminPasswordSet }">
                {{ adminPasswordSet ? '已设置' : '未设置' }}
              </span>
            </div>
            <div class="svc-card-title">为本机服务设置管理员密码</div>
            <p class="svc-card-desc">
              本地启动器在首次启动服务前要求设置非空管理员密码，密码进入系统加密存储（safeStorage），
              不再以明文写入 launcher.json 或命令行参数。此处的密码只用于本机房间的「管理员认证」。
            </p>
            <p v-if="!launcher.available" class="svc-hint">
              当前环境不支持本机密码管理（浏览器预览 / 旧构建）。请在 Music Party 桌面版中使用。
            </p>
            <p class="svc-hint">
              默认监听：{{ listenHint.label }}（{{ listenHint.exposed ? '对外暴露' : '仅本机' }}）
              · 当前管理员认证：{{ adminVerified ? '本次运行已认证' : '未认证' }}
            </p>

            <div class="inline-field" style="gap: 8px; flex-wrap: wrap">
              <button
                class="btn-ghost"
                :disabled="launcher.busy || Boolean(localAdminBusy)"
                title="生成本机强随机管理员密码并保存"
                @click="ensureLocalAdmin"
              >
                {{ localAdminBusy === 'ensure' ? '生成中…' : '生成并保存管理员密码' }}
              </button>
              <button
                class="btn-ghost"
                :disabled="launcher.busy || Boolean(localAdminBusy)"
                title="显示当前保存的本机管理员密码（仅本机可见）"
                @click="revealLocalAdmin"
              >
                {{ localAdminBusy === 'reveal' ? '读取中…' : '显示' }}
              </button>
              <button
                class="btn-ghost"
                :disabled="launcher.busy || Boolean(localAdminBusy) || !localAdminPassword"
                @click="copyLocalAdminPassword"
              >
                复制
              </button>
              <button
                class="btn-ghost danger"
                :disabled="launcher.busy || Boolean(localAdminBusy)"
                @click="clearLocalAdmin"
              >
                {{ localAdminClearArmed ? '确认清除' : '清除' }}
              </button>
            </div>

            <div class="inline-field" style="gap: 8px; margin-top: 8px; flex-wrap: wrap">
              <input
                v-model="localAdminManual"
                class="text-field"
                type="password"
                placeholder="手动设置新的本机管理员密码（非空）"
                autocomplete="new-password"
                spellcheck="false"
                style="max-width: 320px"
              />
              <button
                class="btn-ghost"
                :disabled="launcher.busy || Boolean(localAdminBusy) || !localAdminManual"
                @click="saveLocalAdminManual"
              >
                {{ localAdminBusy === 'set' ? '保存中…' : '保存密码' }}
              </button>
            </div>

            <p v-if="localAdminPassword" class="svc-hint">
              当前显示的密码：<code class="mono">{{ localAdminPassword }}</code>
              <span style="opacity: 0.7">（仅本次显示，刷新/关闭后不再可见，请自行妥善保存）</span>
            </p>
            <p v-if="localAdminError" class="svc-hint" role="alert" style="color: var(--danger); font-weight: 600">
              {{ localAdminError }}
            </p>
            <p v-else-if="localAdminNotice" class="svc-hint">{{ localAdminNotice }}</p>
            <p class="svc-hint">
              忘记密码时：重新生成本机管理员密码后，需要在「管理员认证」中使用新密码。远程服务器的管理员密码
              由服务器自身配置，与本机启动器无关。
            </p>
          </section>

          <section v-if="showFailure" class="svc-fail">
            <span class="svc-fail-title">本地服务未能启动</span>
            <p class="svc-fail-text">{{ failureText }}</p>
            <details v-if="failureLogs.length" class="svc-log">
              <summary>查看最近 {{ failureLogs.length }} 行日志</summary>
              <div v-for="(entry, i) in failureLogs" :key="i" class="svc-log-line">
                <span class="svc-log-service">{{ entry.service }}</span>
                <span class="svc-log-text">{{ entry.line }}</span>
              </div>
            </details>
            <p class="svc-fail-hint">原始输出只在这里折叠展示；连接远程房间不受影响。</p>
          </section>

          <button class="svc-adv-toggle" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
            <ChevronDown :size="14" :class="{ rotated: advancedOpen }" />
            <span>高级设置</span>
            <span class="svc-adv-hint">开发者选项 · 路径 / 端口 / 自动启动</span>
          </button>

          <div v-if="advancedOpen" class="svc-adv">
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">Java 路径</span>
                <span class="setting-desc">留空则使用内置 JRE / 系统 Java</span>
              </div>
              <div class="inline-field svc-path-field">
                <input v-model="form.javaPath" class="text-field" placeholder="自动（内置 JRE / 系统 Java）" spellcheck="false" />
                <button class="btn-ghost" :disabled="choosing === 'java'" @click="chooseResource('java')">选择 Java</button>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">server.jar 路径</span>
                <span class="setting-desc">留空则使用 bin/server.jar 或环境变量 MP_SERVER_JAR</span>
              </div>
              <div class="inline-field svc-path-field">
                <input v-model="form.serverJar" class="text-field" placeholder="自动（bin/server.jar）" spellcheck="false" />
                <button class="btn-ghost" :disabled="choosing === 'jar'" @click="chooseResource('jar')">选择 server.jar</button>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">本地端口</span>
                <span class="setting-desc">Java 后端监听端口</span>
              </div>
              <input v-model="form.localPort" class="text-field" style="max-width: 120px" inputmode="numeric" />
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">BASE URL</span>
                <span class="setting-desc">用于直播流 / 媒体链接拼接</span>
              </div>
              <input v-model="form.baseUrl" class="text-field" style="max-width: 300px" spellcheck="false" />
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">自动启动</span>
                <span class="setting-desc">应用启动后自动拉起本地服务（资源缺失时会静默跳过）</span>
              </div>
              <button class="switch" :class="{ on: form.autoStart }" @click="form.autoStart = !form.autoStart">
                <i></i>
              </button>
            </div>

            <div class="svc-res-list">
              <span class="label">资源探测 · RESOURCES</span>
              <div v-for="row in resourceRows" :key="row.key" class="svc-res-row">
                <span class="service-dot" :class="{ idle: !row.found, warn: row.found && !row.compatible }"></span>
                <span class="svc-res-name">{{ row.name }}</span>
                <span class="svc-res-source">
                  {{ row.found ? row.source : '未找到' }}
                  <template v-if="row.version"> · {{ row.version }}</template>
                </span>
                <span class="svc-res-path" :title="row.path">{{ shortPath(row.path) }}</span>
                <span
                  class="status-pill"
                  :class="{ ok: row.found && row.compatible !== false }"
                >
                  {{ !row.found ? '缺失' : row.compatible === false ? '版本不兼容' : '已找到' }}
                </span>
              </div>
            </div>

            <div class="setting-row svc-ops-row">
              <div class="setting-info">
                <span class="setting-name">服务操作</span>
                <span class="setting-desc">{{ startDisabledReason || (running ? '运行中 · 停止会短暂中断本机播放' : '资源已就绪，可启动') }}</span>
              </div>
              <div class="inline-field" style="flex: 0 0 auto">
                <button
                  class="btn-ghost"
                  :disabled="launcher.busy || running || !ready"
                  :title="startDisabledReason || '启动本地服务'"
                  @click="toggleStart"
                >
                  <PlayCircle :size="13" /> 启动
                </button>
                <button class="btn-ghost" :disabled="launcher.busy || !running" :title="running ? '停止本地服务' : '本地服务未运行'" @click="toggleStart">
                  <Square :size="13" /> 停止
                </button>
                <button class="btn-ghost" :disabled="launcher.busy || !running" :title="running ? '重启本地服务' : '本地服务未运行'" @click="restartServices">重启</button>
                <button class="btn-ghost" @click="openUserData">数据目录</button>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'sources'">
          <!-- 真实状态：来自服务器 PlayerState.config；未加入房间时明确显示“未加入房间” -->
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">网易云音乐</span>
              <span class="setting-desc">{{ neteaseStatusDesc }}</span>
            </div>
            <span class="status-pill" :class="{ ok: neteaseCookieConfigured }">{{ neteaseStatusLabel }}</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">网易云音源开关</span>
              <span class="setting-desc">由房间管理员在管理后台配置；客户端只读</span>
            </div>
            <span class="status-pill">{{ neteaseEnabledLabel }}</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">Bilibili</span>
              <span class="setting-desc">服务端不广播 Cookie 状态；由管理员在管理后台配置（更新后请到搜索验证）</span>
            </div>
            <span class="status-pill">管理员配置</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">更新后如何验证</span>
              <span class="setting-desc">到搜索页试听一首网易云 / B 站歌曲；失败时请联系房间管理员或检查 Cookie 是否过期</span>
            </div>
          </div>
          <div v-if="live.config?.sources?.qqmusic" class="setting-row">
            <div class="setting-info"><span class="setting-name">QQ音乐</span><span class="setting-desc">服务端音源状态；账号凭据由管理员配置。</span></div>
            <span class="status-pill">{{ live.joined ? (live.config.qqmusicEnabled ? '已启用' : '已停用') : '未加入房间' }}</span>
          </div>
        </template>

        <template v-else-if="section === 'room'">
          <!-- 房间密码/锁定/人数/限流都是服务端管理员能力，普通用户只读；真实入口是管理终端。 -->
          <section class="admin-entry-panel">
            <div class="admin-entry-head">
              <ShieldCheck :size="16" :stroke-width="2" />
              <div>
                <span class="label">管理员能力 · ADMIN ONLY</span>
                <div class="admin-entry-title">房间与权限需要管理员认证</div>
              </div>
            </div>
            <p class="admin-entry-text">
              房间密码、锁定房间、人数上限、进入限流、清空队列与系统参数都属于服务端管理员能力，
              密码只在管理终端的内存会话中验证，不会保存在本机。普通成员无法从这里修改房间。
            </p>
            <div class="admin-entry-actions">
              <button class="btn-primary" type="button" @click="emit('open-admin')">
                <ShieldCheck :size="14" :stroke-width="2" />
                {{ adminVerified ? '打开管理终端' : '管理员认证' }}
              </button>
            </div>
          </section>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">当前房间</span>
              <span class="setting-desc">来自实时连接状态；未加入房间时不可修改任何房间设置</span>
            </div>
            <span class="status-pill">{{ roomServerLabel }}</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">连接状态</span>
              <span class="setting-desc">断线会自动重连；重连期间控制命令可能无法发送</span>
            </div>
            <span class="status-pill" :class="{ ok: live.joined && live.connected }">{{ roomConnectedLabel }}</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">管理员会话</span>
              <span class="setting-desc">认证状态只保存在本次运行的内存中；关闭应用或刷新后需要重新认证（安全设计）</span>
            </div>
            <span class="status-pill" :class="{ ok: adminVerified }">{{ adminVerified ? '本次运行已认证' : '未认证' }}</span>
          </div>
        </template>

        <template v-else-if="section === 'data'">
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">应用数据目录</span>
              <span class="setting-desc">Electron userData / Chromium 缓存；由系统 APPDATA 管理，可用下方按钮打开</span>
            </div>
            <div class="inline-field" style="flex: 0 0 auto">
              <code class="data-path">%APPDATA%\music-party-desktop</code>
              <button class="btn-ghost" type="button" @click="openUserData">
                <FolderOpen :size="13" :stroke-width="1.8" /> 打开
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-name">截图 / 评测临时目录</span>
              <span class="setting-desc">
                自动化截图会为每次运行生成临时 Chromium profile（<code>%TEMP%\mp-shot-*</code>）；它们可能长期占用磁盘，
                可在应用外运行 <code>scripts/clean-local-residue.cjs</code> 清理（默认 dry-run，只删临时目录）。
              </span>
            </div>
            <span class="status-pill">非用户数据</span>
          </div>

          <section class="data-panel">
            <div class="data-panel-head">
              <div>
                <span class="label">本机保存的数据 · LOCAL STORAGE</span>
                <p class="data-panel-desc">
                  清除连接记录、昵称、账号绑定、密码、Cookie、设置、缓存和本机房间数据，并停止本机服务。
                  远程服务器与其他成员不受影响。
                </p>
              </div>
              <span class="status-pill">{{ presentCount }} 项存在</span>
            </div>

            <div v-for="item in LOCAL_DATA_KEYS" :key="item.key" class="data-row">
              <code class="data-key">{{ item.key }}</code>
              <span class="data-label">{{ item.label }}</span>
              <span class="data-desc">{{ item.desc }}</span>
              <span class="status-pill" :class="{ ok: localPresence[item.key] }">
                {{ localPresence[item.key] ? '存在' : '不存在' }}
              </span>
            </div>
            <div class="data-row">
              <code class="data-key">mp.desktop.token</code>
              <span class="data-label">房间身份 token</span>
              <span class="data-desc">加入房间后生成；清除后会以新身份重新加入</span>
              <span class="status-pill" :class="{ ok: localPresence['mp.desktop.token'] }">
                {{ localPresence['mp.desktop.token'] ? '存在' : '不存在' }}
              </span>
            </div>

            <div class="data-actions">
              <button class="btn-ghost danger" type="button" @click="emit('clear-data')">
                <Trash2 :size="13" :stroke-width="1.8" />
                清除所有本地数据…
              </button>
              <span class="data-actions-hint">点击后会先二次确认，不会直接删除</span>
            </div>
            <label class="setting-row"><span class="setting-info"><span class="setting-name">关闭窗口时</span><span class="setting-desc">可修改上次记住的选择。</span></span>
              <select :value="closePreference" aria-label="关闭窗口行为" @change="setClosePreference"><option value="ask">每次询问</option><option value="tray">隐藏到托盘</option><option value="close">关闭应用</option></select>
            </label>
          </section>
        </template>
        </div>

        <aside class="settings-aside">
          <section class="setting-card">
            <span class="label">版本信息 · VERSION</span>
            <div class="kv"><span class="kv-k">桌面应用</span><span class="kv-v">{{ appVersion }}</span></div>
            <div class="kv"><span class="kv-k">Electron</span><span class="kv-v">{{ ELECTRON_VERSION }}</span></div>
            <div class="kv">
              <span class="kv-k">内置运行时</span>
              <span class="kv-v">{{ resources.bundled ? '已内置（bin/）' : '未内置（可选）' }}</span>
            </div>
            <div class="kv">
              <span class="kv-k">连接状态</span>
              <span class="kv-v">{{ live.joined ? '实时房间' : '未连接' }}</span>
            </div>
          </section>

          <section class="setting-card">
            <span class="label">演示音乐 · CREDITS</span>
            <p class="setting-desc">演示音乐 Upbeat Visual Novel Music，由 ViRiX 创作；音频未修改，采用 CC BY 3.0 许可。完整曲目和许可说明随软件附带于 demo-audio/LICENSE.txt。</p>
            <p class="setting-desc"><a href="https://opengameart.org/content/upbeat-visual-novel-music" target="_blank" rel="noopener noreferrer">素材来源</a> · <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener noreferrer">CC BY 3.0 许可</a></p>
          </section>

          <section class="setting-card">
            <span class="label">快捷键 · SHORTCUTS</span>
            <div class="shortcut-row">
              <span>全局搜索 / 命令面板</span><span class="status-kbd">CTRL K</span>
            </div>
            <div class="shortcut-row">
              <span>本机静音 / 恢复（不影响房间）</span><span class="status-kbd">SPACE</span>
            </div>
            <div class="shortcut-row">
              <span>暂停 / 恢复房间（长按播放键）</span><span class="status-kbd">长按 0.5s</span>
            </div>
            <div class="shortcut-row">
              <span>切歌</span><span class="status-kbd">CTRL →</span>
            </div>
            <div class="shortcut-row">
              <span>打开设置</span><span class="status-kbd">CTRL ,</span>
            </div>
          </section>

          <section class="setting-card">
            <span class="label">本地数据 · LOCAL DATA</span>
            <div class="kv">
              <span class="kv-k">本机记录</span>
              <span class="kv-v">{{ presentCount }} 项</span>
            </div>
            <div class="kv"><span class="kv-k">数据目录</span><span class="kv-v">%APPDATA%\music-party-desktop</span></div>
            <button class="btn-ghost" type="button" style="margin-top: 8px" @click="section = 'data'">
              <Database :size="13" :stroke-width="1.8" />
              查看 / 清除本地数据
            </button>
          </section>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lyrics-style-row { align-items: flex-start; gap: 18px; }
.lyrics-style-controls { display: flex; flex-direction: column; gap: 10px; max-width: 100%; min-width: 0; }
.lyrics-style-controls .theme-choice { flex-wrap: wrap; }
.lyrics-custom { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.lyrics-custom label, .lyrics-font { display: inline-flex; align-items: center; gap: 5px; color: var(--ink); font-size: 12px; }
.lyrics-custom input[type=number] { width: 54px; color: var(--ink); background: var(--canvas); border: 1px solid var(--line); padding: 4px; }
.lyrics-custom input[type=color] { width: 36px; height: 28px; padding: 1px; border: 1px solid var(--line); background: var(--canvas); }
.lyrics-font select { color: var(--ink); background: var(--canvas); border: 1px solid var(--line); padding: 5px; }
.settings .btn-ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.settings .btn-ghost:disabled:hover {
  background: var(--canvas);
}

.svc-url {
  max-width: 320px;
}

.svc-card {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line-strong);
  background: var(--canvas);
}

.svc-card.is-running {
  border-color: var(--inverse);
}

.svc-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.svc-card-title {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ink-2);
}

.svc-card-desc {
  margin: 0;
  max-width: 640px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.6;
  color: rgba(20, 20, 20, 0.62);
}

.svc-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.svc-hint {
  margin: 0;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.5;
  color: rgba(20, 20, 20, 0.42);
}

.svc-guide {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px dashed var(--line-strong);
}

.svc-guide-intro {
  margin: 0;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.65;
  color: rgba(20, 20, 20, 0.62);
}

.svc-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.65;
  color: rgba(20, 20, 20, 0.72);
}

.svc-steps b {
  font-weight: 700;
  color: var(--ink-2);
}

.svc-steps code,
.svc-guide-note code {
  padding: 1px 4px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 10px;
}

.svc-guide-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.svc-guide-note {
  margin: 0;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.55;
  color: rgba(20, 20, 20, 0.4);
}

.svc-fail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  padding: 12px 16px;
  border: 1px solid rgba(164, 38, 44, 0.35);
  background: var(--canvas);
}

.svc-fail-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--danger);
}

.svc-fail-text {
  margin: 0;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  color: rgba(20, 20, 20, 0.72);
}

.svc-log {
  margin-top: 2px;
  font-size: 10px;
  color: rgba(20, 20, 20, 0.55);
}

.svc-log summary {
  cursor: pointer;
  font-weight: 600;
}

.svc-log-line {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  border-top: 1px solid var(--line);
  font-family: var(--font-mono);
}

.svc-log-service {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(20, 20, 20, 0.4);
}

.svc-log-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.svc-fail-hint {
  margin: 0;
  font-size: 10px;
  font-weight: 500;
  color: rgba(20, 20, 20, 0.4);
}

.svc-adv-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
}

.svc-adv-toggle:hover {
  background: var(--surface-strong);
}

.svc-adv-toggle svg {
  transition: transform var(--dur-2) var(--ease-out);
}

.svc-adv-toggle svg.rotated {
  transform: rotate(180deg);
}

.svc-adv-hint {
  margin-left: auto;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(20, 20, 20, 0.4);
}

.svc-adv {
  margin-top: 10px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  background: var(--surface);
}

.svc-path-field {
  flex: 1 1 420px;
  max-width: 560px;
}

.svc-res-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.svc-res-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  font-size: 11px;
}

.svc-res-name {
  flex: 0 0 132px;
  font-weight: 600;
  color: var(--ink-2);
}

.svc-res-source {
  flex: 0 0 96px;
  font-size: 10px;
  font-weight: 500;
  color: rgba(20, 20, 20, 0.42);
}

.svc-res-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(20, 20, 20, 0.5);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.svc-ops-row {
  border-top: 0;
}

@media (max-width: 1200px) {
  .svc-path-field {
    flex: 1 1 320px;
    max-width: none;
  }

  .svc-res-source {
    display: none;
  }
}

/* ---------- 去假功能新增区块（task-13） ---------- */
.unsupported-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
  padding: 14px 16px;
  border: 1px dashed var(--line-strong);
  background: var(--surface);
}

.unsupported-hint {
  margin: 2px 0 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  color: rgba(20, 20, 20, 0.6);
}

.disabled-row {
  opacity: 0.72;
}

.admin-entry-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
  padding: 16px;
  border: 1px solid var(--line-strong);
  background: var(--canvas);
}

.admin-entry-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.admin-entry-title {
  margin-top: 3px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ink-2);
}

.admin-entry-text {
  margin: 0;
  max-width: 660px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.65;
  color: rgba(20, 20, 20, 0.64);
}

.admin-entry-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.data-path {
  padding: 4px 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(20, 20, 20, 0.66);
  white-space: nowrap;
}

.data-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--line-strong);
  background: var(--canvas);
}

.data-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

.data-panel-desc {
  margin: 5px 0 0;
  max-width: 640px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  color: rgba(20, 20, 20, 0.6);
}

.data-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  border-top: 1px solid var(--line);
  font-size: 11px;
}

.data-row:first-of-type {
  border-top: 0;
}

.data-key {
  flex: 0 0 190px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-2);
}

.data-label {
  flex: 0 0 150px;
  font-weight: 700;
  color: var(--ink-2);
}

.data-desc {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10px;
  font-weight: 500;
  color: rgba(20, 20, 20, 0.56);
}

.data-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.data-actions-hint {
  font-size: 10px;
  font-weight: 500;
  color: rgba(20, 20, 20, 0.5);
}

.data-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
  padding: 12px 14px;
  border-left: 3px solid var(--danger);
  background: rgba(164, 38, 44, 0.06);
}

.data-confirm-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--danger);
}

.data-confirm-text {
  margin: 0;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.65;
  color: rgba(20, 20, 20, 0.68);
}

.data-confirm-text code,
.data-desc code,
.setting-desc code {
  padding: 0 3px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 10px;
}

.data-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.btn-ghost.danger {
  color: var(--danger);
  border-color: rgba(164, 38, 44, 0.4);
}

.btn-ghost.danger:hover {
  background: rgba(164, 38, 44, 0.08);
}

.btn-primary.danger {
  background: var(--danger);
}

.btn-primary.danger:hover {
  background: #8f1d21;
}

@media (max-width: 1200px) {
  .data-key {
    flex-basis: 150px;
  }

  .data-label {
    flex-basis: 112px;
  }
}
</style>

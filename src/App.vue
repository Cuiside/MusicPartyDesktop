<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  Activity,
  AtSign,
  CalendarDays,
  Copy,
  Disc3,
  Headphones,
  Heart,
  History as HistoryIcon,
  Layers,
  Link2,
  ListMusic,
  Lock,
  LogIn,
  LogOut,
  MessageSquare,
  Mic2,
  Music2,
  Pause,
  Pin,
  Play,
  PlayCircle,
  Radio,
  RotateCw,
  Search as SearchIcon,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  Users,
  Video,
  Volume2,
  VolumeX
} from 'lucide-vue-next'
import WindowFrame from './components/WindowFrame.vue'
import UserHelp from './components/UserHelp.vue'
import NavRail from './components/NavRail.vue'
import AppSidebar from './components/AppSidebar.vue'
import CommandBar from './components/CommandBar.vue'
import StatusBar from './components/StatusBar.vue'
import RoomInspector from './components/RoomInspector.vue'
import TrackInspector from './components/TrackInspector.vue'
import PartyView from './views/PartyView.vue'
import QueueView from './views/QueueView.vue'
import LikedSongsView from './views/LikedSongsView.vue'
import { useLikedSongs } from './core/local-likes.js'
import SearchView from './views/SearchView.vue'
import ChatView from './views/ChatView.vue'
import HistoryView from './views/HistoryView.vue'
import ConsoleView from './views/ConsoleView.vue'
import SettingsView from './views/SettingsView.vue'
import ContextMenu from './components/ContextMenu.vue'
import CommandPalette from './components/CommandPalette.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import Toasts from './components/Toasts.vue'
import RoomLikeEffect from './components/RoomLikeEffect.vue'
import StatesView from './views/StatesView.vue'
import AdminView from './views/AdminView.vue'
import NicknameDialog from './components/NicknameDialog.vue'
import OnboardingView, { isLocalHostServer } from './components/OnboardingView.vue'
import JoinDialog from './components/JoinDialog.vue'
import TutorialOverlay, { TUTORIAL_KEY } from './components/TutorialOverlay.vue'
import AdminAuthDialog from './components/AdminAuthDialog.vue'
import TrayCard from './components/TrayCard.vue'
import { demo, navItems } from './core/demo'
import {
  playback,
  setLocalVolume,
  toggleLocalMute,
  hasSeenLocalMuteHint,
  markLocalMuteHintSeen,
  togglePlay
} from './core/playback'
import { connection, goOffline, goOnline } from './core/connection'
import { pushToast } from './core/toast'
import { live } from './core/live/state'
import { session } from './core/live/session'
import { refreshPlaybackMedia } from './core/live/api'
import { createMediaRecovery } from './core/live/media-recovery'
import { adminAuth } from './core/live/admin.js'
import { ensureSongDisplayFields } from './core/live/mapping'
import { DEFAULT_SERVER, loadSettings, httpBase, normalizeServerUrl, saveSettings } from './core/live/config'
import {
  engine,
  setTrack as audioSetTrack,
  syncTo as audioSyncTo,
  setBaseUrl as audioSetBaseUrl,
  setVolume as audioSetVolume,
  mute as audioMute,
  pause as audioPause,
  resolveMediaUrl as audioResolveMediaUrl
} from './core/audio/engine'
import { pushTrayState, onTrayCommand } from './core/tray-bridge'
import { onRoomLike, onRoomChat } from './core/live/transport.js'
import { barEnvelope } from './core/audio/visualizer.js'
import { lyricStyle } from './core/desktop-lyrics-style.js'
import {
  joinRoom,
  leaveRoom,
  rename as liveRename,
  isGuestLikeName,
  addToQueue as liveAddToQueue,
  removeFromQueue as liveRemoveFromQueue,
  reorderQueue as liveReorderQueue,
  claimPlaylist as liveClaimPlaylist,
  setPlayMode as liveSetPlayMode,
  seekRoom as liveSeekRoom,
  togglePlay as liveTogglePlay,
  skip as liveSkip,
  like as liveLike,
  pin as livePin,
  sendChat as liveSendChat,
  getLyrics as liveGetLyrics,
  getRoomSnapshot,
  setSessionLifecycleListener
} from './core/live/client'

const initialParams = new URLSearchParams(window.location.search)
const initialView = initialParams.get('view')
/**
 * 托盘状态卡窗口（主进程用 `?tray=1` 加载）：只渲染 <TrayCard />，不加载完整应用壳。
 * TrayCard 由 launcher-ipc 提供，自身通过 src/core/tray-bridge.js 读取缓存状态。
 */
const isTrayWindow = initialParams.get('tray') === '1'
const devViews = ['states']
const active = ref(
  navItems.some((n) => n.id === initialView)
    ? initialView
    : devViews.includes(initialView)
      ? initialView
      : 'party'
)

const queue = reactive(demo.queue.map((s) => ({ ...s })))
const demoCurrent = ref({ ...demo.nowPlaying })
const demoAudioActive = ref(false)
const demoChat = reactive(demo.chat.map((m) => ({ ...m })))
const savedLiveSettings = loadSettings()

/* The user's own room target ("我的房间"): an explicitly saved own-server address,
   else the local backend default. It is stored under its own key so that joining a
   friend's room never silently turns "我的房间" into somebody else's server. */
const MINE_ROOM_KEY = 'mp.room.mine.v1'
const readMineServer = () => {
  try {
    const stored = localStorage.getItem(MINE_ROOM_KEY)
    if (stored) return normalizeServerUrl(stored)
  } catch {
    /* private mode */
  }
  if (isLocalHostServer(savedLiveSettings.serverUrl)) return savedLiveSettings.serverUrl
  return DEFAULT_SERVER
}
const myRoomServer = ref(readMineServer())
const saveMyRoomServer = (serverUrl) => {
  myRoomServer.value = normalizeServerUrl(serverUrl)
  try {
    localStorage.setItem(MINE_ROOM_KEY, myRoomServer.value)
  } catch {
    /* private mode */
  }
}

const joinOpen = ref(false)
const joining = ref(false)
const joinError = ref(
  initialParams.get('onboardingError') === '1' ? '房间密码错误（INVALID_ROOM_PASSWORD）' : ''
)
/* Public build: the default nickname is「游客」. Older builds persisted「你」as the
   default; treat that legacy value as "unset" so upgraders get the new default. */
const savedUserName = savedLiveSettings.userName === '你' ? '' : savedLiveSettings.userName
const joinForm = reactive({
  serverUrl: savedLiveSettings.serverUrl,
  name: savedUserName || '游客',
  password: ''
})

const liveMode = computed(() => live.joined)
/* 展示层数据防御：外部注入/异常负载可能缺少 `cover` 等展示字段，子组件（TrackCover /
   QueueTable / TrackInspector / PartyView）在渲染时直接访问这些字段会抛错并中断 patch
   （运行时回归曾因此表现为“检查器停在房间检查器”）。统一在 App 边界补齐默认展示字段。 */
const nowPlayingView = computed(() =>
  ensureSongDisplayFields(liveMode.value ? live.nowPlaying : demoCurrent.value)
)
const queueView = computed(() => {
  const list = liveMode.value ? live.queue : queue
  return Array.isArray(list) ? list.map((item) => {
    const song = ensureSongDisplayFields(item)
    if (!liveMode.value) return song
    const owner = String(song.ownerId || '')
    const canClaim = Boolean(live.compactSync && live.config.allowPlaylistClaim && owner && !song.ownerGuest && owner !== live.identity?.id &&
      !['SYSTEM', 'ADMIN'].includes(owner) && !owner.startsWith('__') && !live.members.some(member => member.id === owner))
    return { ...song, canClaim }
  }) : list
})
const lyricsView = computed(() => (liveMode.value ? live.lyrics : demo.lyrics))
// Reuse loaded lyrics and the local audio clock; no additional requests.
const desktopLyrics = window.mpDesktop?.lyrics
const desktopLyricsOpen = ref(false)
let unsubscribeDesktopLyrics = () => {}
if (desktopLyrics && !isTrayWindow) {
  unsubscribeDesktopLyrics = desktopLyrics.onVisibility((visible) => { desktopLyricsOpen.value = visible === true })
  desktopLyrics.isOpen().then((visible) => { desktopLyricsOpen.value = visible }).catch(() => {})
  watch(() => {
    const time = Number(engine.currentTime) || 0
    let line = null
    if (nowPlayingView.value) {
      for (const item of lyricsView.value || []) {
        if (Number(item.t) <= time && (!line || Number(item.t) >= Number(line.t))) line = item
      }
    }
    const next = line && (lyricsView.value || []).find(item => Number(item.t) > Number(line.t))
    const start = Number(line?.t) || 0
    const end = next ? Number(next.t) : Number(engine.duration || nowPlayingView.value?.duration) || start
    return { text: line?.text || '', trans: line?.trans || '', ...lyricStyle, muted: playback.muted, liked: Boolean(nowPlayingView.value?.likedByMe), time, start, end, playing: engine.playing }
  }, (line) => desktopLyrics.setState(line), { immediate: true })
}
onBeforeUnmount(() => unsubscribeDesktopLyrics())
const chatMessages = computed(() => (liveMode.value ? live.chat : demoChat))
const instantChatMessages = computed(() => (liveMode.value ? live.sessionChat : demoChat.slice(demoInstantStart.value)))
const unreadChat = ref(0)
watch(() => session.generation, () => { unreadChat.value = 0; desktopLyrics?.showLike?.({ message:'' }) })
const demoInstantStart = ref(demoChat.length)
const membersView = computed(() => (liveMode.value ? live.members : demo.members))
const activityView = computed(() => (liveMode.value ? live.activity : demo.activity))
const showReconnect = computed(
  () => (liveMode.value && live.reconnecting) || (!liveMode.value && !connection.online)
)

/* ---------- 侧栏筛选/检查器状态（真实数据驱动） ----------
   这些状态是侧栏「当前页」组与命令栏分段的唯一数据源：
   - queueFilter/queueSource 真实过滤 queueView（客户端过滤，服务端无需接口）；
   - chatFilter 真实过滤聊天消息类型；
   - roomInspectorSection 决定右侧房间检查器显示哪个分区（房间/成员/活动）。 */
const { likedSongs, addLikedSong } = useLikedSongs()
const showLikedSongs = ref(false)
const queueFilter = ref('all') // all | mine | pinned
const queueSource = ref('all') // all | netease | bilibili
const chatFilter = ref('all') // all | system | me
const roomInspectorSection = ref('all') // all | info | members | activity

/** 复制服务器地址（服务端没有邀请链接/房间码，真实可用的是地址 + 房间密码）。
 *  D-12：必须使用完整、不可变的会话 base（含 https 与代理路径前缀），不得用展示 host 重构。 */
const copyServerAddress = () => {
  const url = live.sessionBase || httpBase(savedLiveSettings.serverUrl)
  copyText(url)
  pushToast(`服务器地址已复制：${url}`)
}

const mediaRecovery = createMediaRecovery({
  current: () => liveMode.value && live.connected && live.nowPlaying ? {
    session: session.generation, playbackId: live.playbackId, id: live.nowPlaying.id,
    source: live.nowPlaying.source, kind: live.nowPlaying.kind, url: live.nowPlaying.url
  } : null,
  refresh: refreshPlaybackMedia,
  apply: url => {
    audioSetTrack({ url, duration: live.nowPlaying?.duration || 0, startAt: live.progress || 0, baseUrl: live.sessionBase })
    audioSyncTo(live.progress || 0, live.playing)
  }
})

/* ---------- D-14 会话生命周期：最终结束后统一清理音频/歌词/进度 ----------
   transport 在「主动离开 / 换房 / PASSWORD_CHANGED / INVALID_ROOM_PASSWORD / 致命认证失败」
   等最终 teardown 时触发；短暂断线重连（live.reconnecting）不触发，音频继续缓冲播放。 */
function cleanupLiveAudio() {
  mediaRecovery.reset()
  try {
    audioPause()
  } catch {
    /* 引擎未就绪 */
  }
  try {
    audioSetTrack(null)
  } catch {
    /* 引擎未就绪 */
  }
  playback.progress = 0
  playback.playing = false
}

const disposeSessionLifecycle = setSessionLifecycleListener((info) => {
  cleanupLiveAudio()
  live.lyrics = []
  // 致命 teardown（房间密码变更 / INVALID_ROOM_PASSWORD / 认证失败等）：带着原因回到加入界面。
  if (info?.error) {
    joinError.value = info.error
    joining.value = false
    tutorialActive.value = false
    adminOpen.value = false
    showOnboarding.value = true
    active.value = 'party'
    pushToast(`连接已结束：${info.error}`, 'warn')
  }
})

/* ---------- first-run experience: onboarding page, demo opt-in, guided tour ----------
   A normal launch starts on the join/onboarding page. Demo data is only shown after
   an explicit click on「进入演示界面」or when an automation harness asks for the shell
   (`?shot` / `?eval` / `?live` / `?join` / `?demo` / `?view` / `?tutorial`).
   `?onboarding=1` is the strongest override and is used by the screenshot harness. */
const automationRun =
  initialParams.get('shot') === '1' ||
  initialParams.get('eval') === '1' ||
  initialParams.get('live') === '1' ||
  initialParams.get('join') === '1' ||
  initialParams.get('demo') === '1' ||
  initialParams.get('tutorial') === '1' ||
  initialParams.has('view')

const showOnboarding = ref(initialParams.get('onboarding') === '1' || !automationRun)
const onboardingAdvanced = initialParams.get('adv') === '1'
const demoShell = computed(() => !liveMode.value && !showOnboarding.value)

function startDemoTrack(song) {
  if (!song?.url) return
  demoCurrent.value = { ...song }
  playback.progress = 0
  playback.duration = song.duration
  const url = new URL(song.url, document.baseURI).href
  demoAudioActive.value = true
  audioSetTrack({ url, duration: song.duration, crossOrigin: false })
  audioSyncTo(0, playback.playing)
}

function stopDemoAudio() {
  demoAudioActive.value = false
  audioPause()
  audioSetTrack(null)
}

function nextDemoTrack() {
  if (!queue.length) return
  const current = queue.findIndex(song => song.url === demoCurrent.value?.url)
  const next = queue[(current + 1) % queue.length]
  playback.playing = true
  startDemoTrack(next)
}

/* ---- admin authentication (AdminAuthDialog + AdminView) ----
   `adminAuth` (core/live/admin.js) is the single in-memory admin session — it is
   never persisted by the app. Entry points: the account menu item「管理员认证」and
   the command palette. After verification the console nav entry becomes visible;
   `consoleLocked` is the single source of truth for hiding/unlocking it. */
const adminAuthOpen = ref(false)
const adminOpen = ref(false)
const adminAuthed = computed(() => Boolean(adminAuth.verified))
const consoleLocked = computed(() => liveMode.value && !live.admin && !adminAuthed.value)

/* ---------- interface tutorial (spotlight overlay, see TutorialOverlay.vue) ---------- */
const tutorialActive = ref(false)
const helpOpen = ref(false)
const tutorialStartStep = ref(0)
const tutorialStepNow = ref(0)
/** Dev-only: screenshots of the admin step include it without granting any rights. */
const tutorialAdminForce = initialParams.get('tutorialAdmin') === '1'
const tutorialAdminAvailable = computed(
  () => Boolean(live.admin) || adminAuthed.value || tutorialAdminForce
)

const startTutorial = (step = 0) => {
  if (settingsOpen.value) settingsOpen.value = false
  if (active.value !== 'party') active.value = 'party'
  tutorialStartStep.value = Math.max(0, Number(step) || 0)
  tutorialActive.value = true
}

const finishTutorial = () => {
  tutorialActive.value = false
}

/** First successful join / first demo entry auto-starts the tour (once, not on the
 *  onboarding page, never in screenshot / eval automation runs). */
const maybeStartTour = () => {
  if (automationRun) return
  try {
    if (localStorage.getItem(TUTORIAL_KEY)) return
  } catch {
    return
  }
  setTimeout(() => startTutorial(0), 600)
}

watch(adminAuth, () => {
  if (!adminAuth.verified) {
    adminOpen.value = false
  }
})

const selectedId = ref('')
const selectedSong = computed(
  () => filteredQueueView.value.find((s) => s.id === selectedId.value) || null
)
const searchSelected = ref(null)
const historySelected = ref(null)
const settingsOpen = ref(initialView === 'settings')
const accountMenu = ref(null)
const paletteOpen = ref(false)
const paletteInitialQuery = ref('')
const confirmState = ref(null)
const clearingLocalData = ref(false)

/* ---------- 关闭询问（主进程 close 拦截 → 渲染层三选一） ----------
   launcher-ipc 的契约：
   - window.mpDesktop.window.onCloseRequest(cb) → cb({ id, canTray })；
   - window.mpDesktop.window.respondClose('close' | 'tray' | 'cancel')；
   - 关闭提示由渲染层显示；渲染进程异常或无响应时主进程退出，避免卡死。
   自动化（MP_SHOT / MP_EVAL）下主进程不拦截真实关闭，仅 MP_CLOSE_PROMPT=1 会派发模拟请求。 */
const closePrompt = ref(null)
const rememberClose = ref(false)
const closeDefaultButton = ref(null)
const closePromptOpen = computed(() => Boolean(closePrompt.value))
let closeRequestUnsub = null

const onCloseRequest = (payload) => {
  rememberClose.value = false
  closePrompt.value = {
    id: payload && payload.id != null ? payload.id : null,
    canTray: !payload || payload.canTray !== false
  }
}

/**
 * 响应主进程的关闭询问。'tray' = 隐藏到托盘继续后台播放；'close' = 退出应用；'cancel' = 留下。
 *
 * @param {'close' | 'tray' | 'cancel'} action
 * @returns {void}
 */
const respondClose = (action) => {
  if (!closePrompt.value) return
  closePrompt.value = null
  try {
    window.mpDesktop?.window?.respondClose?.(action, rememberClose.value && action !== 'cancel')
  } catch {
    /* preload 未就绪（浏览器预览）时忽略 */
  }
}

watch(closePromptOpen, async (open) => {
  if (!open) return
  await nextTick()
  closeDefaultButton.value?.focus?.()
})

const navRail = ref(null)
const accountItems = computed(() => [
  { id: 'avatar', label: '选择头像', icon: UserRound },
  ...(liveMode.value
    ? [
        { id: 'nickname', label: '设置昵称 / 修改昵称', icon: UserRound },
        { id: 'disconnect', label: '断开并回到加入界面', icon: LogOut }
      ]
    : [
        { id: 'onboarding', label: '回到加入界面', icon: LogIn },
        { id: 'connect', label: '加入房间…', icon: Server }
      ]),
  { id: 'settings', label: '设置', icon: Settings },
  { id: 'admin', label: '管理员认证', icon: ShieldCheck }
])

const openAccountMenu = () => {
  accountMenu.value = { x: 64, y: window.innerHeight - 240 }
}

/* Join dialog, onboarding return and demo opt-in share these small helpers so the
   flows stay consistent across titlebar, account menu, palette and sidebar. */
const openJoinDialog = () => {
  joinError.value = ''
  joinOpen.value = true
}

const onTitlebarSearch = () => {
  // The search palette is a shell feature; the onboarding page has no demo commands.
  if (showOnboarding.value) return
  paletteInitialQuery.value = ''
  paletteOpen.value = true
}

const findHistorySong = (title) => { paletteInitialQuery.value = String(title || ''); paletteOpen.value = true }

const enterDemoMode = () => {
  demoInstantStart.value = demoChat.length
  showOnboarding.value = false
  joinOpen.value = false
  paletteOpen.value = false
  playback.playing = true
  startDemoTrack(queue[0] || demo.nowPlaying)
  pushToast('演示模式 · 开放授权音乐')
  maybeStartTour()
}

const requestOnboarding = () => {
  if (liveMode.value) {
    askConfirm({
      title: '回到加入界面？',
      text: '将断开当前房间连接（其他成员不受影响），然后重新选择要进入的房间。',
      confirmLabel: '断开并返回',
      onConfirm: () => void doLeave()
    })
    return
  }
  joinOpen.value = false
  stopDemoAudio()
  paletteOpen.value = false
  joinError.value = ''
  showOnboarding.value = true
}

/**
 * Admin console entry point (account menu / palette / locked console page).
 * Opens AdminAuthDialog; on success App opens AdminView. The session lives only in
 * `core/live/admin.js` memory (never persisted).
 */
const openAdminAuth = () => {
  adminAuthOpen.value = true
}

/** 已认证时直接打开管理终端，否则先走认证弹层（统一入口）。 */
const openAdminPanel = () => {
  if (adminAuth.verified) adminOpen.value = true
  else adminAuthOpen.value = true
}

/** 设置页清除了本机服务器/昵称/教程记忆后，把内存里的状态也复位并回到加入界面。 */
const handleLocalDataCleared = () => {
  joinForm.name = '游客'
  joinForm.password = ''
  joinForm.serverUrl = DEFAULT_SERVER
  myRoomServer.value = DEFAULT_SERVER
  savedLiveSettings.serverUrl = DEFAULT_SERVER
  savedLiveSettings.userName = ''
  tutorialActive.value = false
  settingsOpen.value = false
  showOnboarding.value = true
  active.value = 'party'
  pushToast('已清除本机数据：服务器地址 / 昵称 / 教程记忆')
}

const requestClearLocalData = () => askConfirm({
  title: '清除所有本地数据？',
  text: '将断开当前房间并停止本机服务，删除本机连接记录、昵称、账号绑定、保存的密码与 Cookie、设置、缓存和本机房间数据。远程服务器与其他成员不受影响。此操作无法撤销。',
  confirmLabel: '清除本地数据', danger: true,
  onConfirm: async () => {
    clearingLocalData.value = true
    try {
      await leaveRoom()
      audioPause()
      const clear = window.mpDesktop?.launcher?.clearLocalData
      if (!clear) throw new Error('当前环境无法清除桌面数据')
      const result = await clear()
      if (!result?.ok) throw new Error(result?.error || '清除失败')
      window.location.reload()
    } catch (error) { clearingLocalData.value = false; pushToast(`清除失败：${error.message}`, 'warn') }
  }
})

const handleAccountSelect = (id) => {
  accountMenu.value = null
  if (id === 'avatar') navRail.value?.openAvatarPicker()
  else if (id === 'settings') settingsOpen.value = true
  else if (id === 'connect') openJoinDialog()
  else if (id === 'onboarding') requestOnboarding()
  else if (id === 'disconnect') requestOnboarding()
  else if (id === 'nickname') openNicknameDialog()
  else if (id === 'admin') openAdminPanel()
}

/** 导航栏选择：历史在实时房间禁用；控制台在实时房间只有管理员认证后可达（打开真实 AdminView）。 */
const onNavSelect = (id) => {
  if (id === 'history') {
    if (liveMode.value) {
      pushToast('实时房间暂不支持历史记录（服务端没有历史接口）', 'warn')
      return
    }
    active.value = 'history'
    return
  }
  if (id === 'console') {
    if (liveMode.value && adminAuthed.value) {
      openAdminPanel()
      return
    }
    active.value = 'console'
    return
  }
  active.value = id
}

/* ---------- command palette ---------- */
const paletteItems = computed(() => {
  if (showOnboarding.value) {
    return [
      {
        id: 'settings',
        group: '操作',
        label: '打开设置',
        desc: '启动本地服务 / 播放 / 音源',
        icon: Settings,
        shortcut: 'CTRL ,'
      },
      {
        id: 'demo',
        group: '操作',
        label: '进入演示界面（原创测试音频）',
        desc: '先预览界面与功能',
        icon: Sparkles
      }
    ]
  }
  return [
    ...(liveMode.value
      ? [
          {
            id: 'resync',
            group: '连接',
            label: '重新同步房间状态',
            desc: `${live.server} · 请求完整快照`,
            icon: RotateCw
          },
          {
            id: 'disconnect',
            group: '连接',
            label: '断开并回到加入界面',
            desc: '离开当前房间，重新选择房间',
            icon: LogOut
          }
        ]
      : [
          {
            id: 'connect',
            group: '连接',
            label: '加入房间…',
            desc: joinForm.serverUrl,
            icon: Server
          },
          {
            id: 'welcome',
            group: '连接',
            label: '回到加入界面',
            desc: '重新选择「我的房间」或加入朋友的房间',
            icon: LogIn
          }
        ]),
    { id: 'go-party', group: '跳转', label: '前往 派对现场', desc: '正在播放与房间动态', icon: Disc3, shortcut: 'G P' },
    { id: 'go-queue', group: '跳转', label: '前往 队列', desc: `${queueView.value.length} 首待播`, icon: ListMusic },
    { id: 'go-search', group: '跳转', label: '前往 搜索', desc: '网易云 · Bilibili', icon: SearchIcon },
    { id: 'go-chat', group: '跳转', label: '前往 聊天', desc: `${chatMessages.value.length} 条消息`, icon: MessageSquare },
    // 服务端没有历史接口：真实房间不提供历史入口；演示模式保留并明确标注演示。
    ...(liveMode.value
      ? []
      : [
          {
            id: 'go-history',
            group: '跳转',
            label: '前往 历史（演示）',
            desc: `演示数据 · ${demo.history.length} 条，非真实记录`,
            icon: HistoryIcon
          }
        ]),
    ...(liveMode.value
      ? []
      : [{ id: 'go-console', group: '跳转', label: '前往 控制台（演示）', desc: '只读演示预览 · 不修改真实服务', icon: Lock }]),
    {
      id: 'local-mute',
      group: '播放',
      label: playback.muted ? '恢复本机声音' : '静音本机（不影响房间）',
      desc: '只改 APP 媒体音量 · 不碰系统音量与他人',
      icon: playback.muted ? VolumeX : Volume2,
      shortcut: 'SPACE'
    },
    {
      id: 'toggle-play',
      group: '播放',
      label: playback.playing ? '暂停房间播放' : '恢复房间播放',
      desc: '同步到房间内所有人 · 需成员权限（长按播放键同效）',
      icon: playback.playing ? Pause : Play
    },
    {
      id: 'stream-help',
      group: '播放',
      label: '如何获取直播流链接',
      desc: '在聊天中发送 //stream，服务端会私聊把链接发给你',
      icon: Link2
    },
    { id: 'settings', group: '操作', label: '打开设置', desc: '播放 / 服务 / 音源 / 本地数据', icon: Settings, shortcut: 'CTRL ,' },
    { id: 'tour', group: '帮助', label: '重新查看界面引导', desc: '聚光灯分步介绍桌面端主要控件', icon: Sparkles },
    ...(liveMode.value && !adminAuthed.value
      ? [
          {
            id: 'admin-auth',
            group: '管理员',
            label: '管理员认证',
            desc: '认证后可打开真实管理终端（房间 / 音源 / 系统）',
            icon: ShieldCheck
          }
        ]
      : []),
    ...(liveMode.value && adminAuthed.value
      ? [
          {
            id: 'open-admin-console',
            group: '管理员',
            label: '打开管理终端',
            desc: '真实管理员配置中心（本次运行已认证）',
            icon: ShieldCheck
          }
        ]
      : []),
    { id: 'clear-queue', group: '操作', label: '清空播放队列', desc: `移除 ${queueView.value.length} 首待播歌曲`, icon: Trash2, danger: true }
  ]
})

const copyText = (text) => {
  try {
    navigator.clipboard?.writeText(text)
  } catch {
    /* clipboard unavailable in some capture contexts */
  }
}

const askConfirm = (options) => {
  confirmState.value = options
}

const runConfirm = () => {
  const current = confirmState.value
  confirmState.value = null
  current?.onConfirm?.()
}

const paletteSelect = (item) => {
  paletteOpen.value = false
  const id = item.id
  if (id.startsWith('go-')) {
    if (id === 'go-history' && liveMode.value) {
      pushToast('实时房间暂不支持历史记录（服务端没有历史接口）', 'warn')
      return
    }
    active.value = id.slice(3)
    return
  }
  if (id === 'connect') {
    openJoinDialog()
    return
  }
  if (id === 'disconnect') {
    requestOnboarding()
    return
  }
  if (id === 'welcome') {
    requestOnboarding()
    return
  }
  if (id === 'resync') {
    getRoomSnapshot().then(() => pushToast('已重新同步房间状态'))
    return
  }
  if (id === 'settings') {
    settingsOpen.value = true
  } else if (id === 'demo') {
    enterDemoMode()
  } else if (id === 'tour') {
    startTutorial(0)
  } else if (id === 'admin-auth') {
    openAdminAuth()
  } else if (id === 'open-admin-console') {
    openAdminPanel()
  } else if (id === 'local-mute') {
    handleLocalMute()
  } else if (id === 'toggle-play') {
    handleTogglePlay()
  } else if (id === 'stream-help') {
    askConfirm({
      title: '如何获取直播流链接',
      text: '服务端没有 HTTP 生成链接的接口：在聊天里发送 //stream，服务端会把带 token 的完整直播流链接私聊发给你（与网页版一致，链接有时效）。桌面端不再提供伪造的「复制直播流地址」按钮。',
      confirmLabel: '知道了',
      onConfirm: () => {}
    })
  } else if (id === 'clear-queue') {
    if (consoleLocked.value) {
      pushToast('清空队列需要管理员权限', 'warn')
      return
    }
    askConfirm({
      title: '清空播放队列？',
      text: '将移除全部待播歌曲（保留当前播放），此操作会同步到房间内所有人。',
      confirmLabel: '清空队列',
      danger: true,
      onConfirm: async () => {
        if (liveMode.value) {
          const items = [...queueView.value]
          const results = await Promise.all(items.map((item) => liveRemoveFromQueue(item)))
          summarizeCommandResults(results, '清空队列')
        } else {
          queue.splice(0, queue.length)
          pushToast('队列已清空')
        }
      }
    })
  }
}

/* ---------- live connection ---------- */
const doJoin = async () => {
  if (joining.value) return
  if (demoAudioActive.value) stopDemoAudio()
  joining.value = true
  joinError.value = ''
  try {
    const ok = await joinRoom({
      name: joinForm.name,
      password: joinForm.password,
      serverUrl: joinForm.serverUrl
    })
    if (ok) {
      joinOpen.value = false
      showOnboarding.value = false
      active.value = 'party'
      joinError.value = ''
      Object.assign(
        savedLiveSettings,
        saveSettings({ serverUrl: live.sessionBase || joinForm.serverUrl, userName: joinForm.name })
      )
      joinForm.serverUrl = savedLiveSettings.serverUrl
      pushToast(`已加入房间 · ${live.roomName || live.server}`)
      if (live.nowPlaying) void liveGetLyrics(live.nowPlaying)
      maybeStartTour()
      // If the server kept us as a guest (nickname reserved/duplicate), explain why the
      // transport controls will not work and offer to set a real nickname.
      setTimeout(() => {
        if (!automationRun && liveMode.value && isGuestIdentity.value) {
          openNicknameDialog('当前是游客身份，只能浏览；设置昵称后才能点歌、聊天和控制播放。')
        }
      }, 2400)
    } else {
      joinError.value = live.error || '连接失败，请检查服务器地址与房间密码'
    }
  } catch (error) {
    joinError.value = String(error?.message || error)
  } finally {
    joining.value = false
  }
}

/** Join request coming from the onboarding page or the join dialog. */
const handleJoinRequest = (payload = {}) => {
  joinForm.serverUrl = payload.serverUrl || joinForm.serverUrl
  joinForm.name = payload.name || joinForm.name
  joinForm.password = payload.password || ''
  if (payload.mine) saveMyRoomServer(joinForm.serverUrl)
  void doJoin()
}

const doLeave = async () => {
  audioPause()
  try { await leaveRoom() } catch (error) { console.warn('[room] leave failed:', error) }
  tutorialActive.value = false
  adminOpen.value = false
  settingsOpen.value = false
  joinOpen.value = false
  joinError.value = ''
  showOnboarding.value = true
  active.value = 'party'
  pushToast('已断开房间连接')
}

/**
 * D-16 服务器切换事务（SettingsView 在「已连接 且 新 base ≠ 当前会话 base」时触发）。
 *
 * 顺序固定为：原子 teardown 旧会话（退出 WS、清 admin 会话/在途命令与歌词、清音频、
 * 清 live 状态）→ 保存新的“下次连接地址” → 可选自动重连（仅本机服务，远程房间可能
 * 需要房间密码，于是回到加入界面让用户确认）。由于所有 HTTP/WS/媒体/管理请求都读同一个
 * 会话 base，事务完成前不可能出现「HTTP 已去 B、WS 仍在 A」。
 */
const handleServerChange = async (payload = {}) => {
  const raw = String(payload.url || '').trim()
  if (!raw) return
  const previousBase = payload.previousBase || live.sessionBase || ''
  // 1) 原子 teardown 旧会话（内部会 adminLogout / 清歌词 / 触发 D-14 音频清理）。
  await leaveRoom()
  // 2) 事务完成后再保存新的“下次连接地址”。
  const saved = saveSettings({ serverUrl: raw, mode: 'remote' })
  Object.assign(savedLiveSettings, saved)
  joinForm.serverUrl = saved.serverUrl
  joinForm.password = ''
  joinForm.name = String(saved.userName || '').trim() || '游客'
  joinError.value = ''
  showOnboarding.value = true
  settingsOpen.value = false
  active.value = 'party'
  pushToast(previousBase ? `已断开旧服务器：${previousBase}` : '服务器地址已保存')
  // 3) 本机服务可自动重连；远程房间回到加入界面（可能需要房间密码）。
  if (isLocalHostServer(saved.serverUrl)) {
    pushToast('正在连接本机服务…')
    await doJoin()
  } else {
    pushToast('新地址已保存，请在加入界面确认后连接')
  }
}

/* ---------- guest → member (nickname) ----------
   The server registers every new STOMP session as a guest and ignores play/pause/skip
   from guests (the web client does the same via `requireAuth` → name modal). We mirror
   that: guests get a nickname dialog instead of a silently dropped command. */
const nicknameOpen = ref(false)
const nicknameBusy = ref(false)
const nicknameError = ref('')

const isGuestIdentity = computed(() => {
  if (!liveMode.value) return false
  const identity = live.identity
  if (identity && typeof identity.isGuest === 'boolean') return identity.isGuest
  const me = live.members.find((member) => member.you)
  return me ? me.role === '游客' : true
})

const openNicknameDialog = (message = '') => {
  if (!liveMode.value) return
  nicknameError.value = message
  nicknameOpen.value = true
}

const submitNickname = async (name) => {
  const value = String(name || '').trim()
  if (!value) return
  if (isGuestLikeName(value)) {
    nicknameError.value = '不能使用「游客」或以 guest 开头的昵称，请换一个'
    return
  }
  nicknameBusy.value = true
  nicknameError.value = ''
  const result = await liveRename(value)
  if (!result.ok) {
    nicknameBusy.value = false
    nicknameError.value =
      result.code === 'OFFLINE' ? '连接已断开，请重新加入房间' : result.message || result.reason || '昵称设置失败'
    return
  }
  setTimeout(() => {
    nicknameBusy.value = false
    if (live.identity && live.identity.isGuest === false) {
      nicknameOpen.value = false
      joinForm.name = value
      try {
        saveSettings({ userName: value })
      } catch {
        /* ignore */
      }
      pushToast(`昵称已设置：${value}，现在可以点歌、聊天和控制播放`)
    } else {
      nicknameError.value = live.renameError || '昵称设置失败：可能已被占用，请换一个'
    }
  }, 1500)
}

watch(
  () => live.renameError,
  (error) => {
    if (liveMode.value && error) pushToast(error, 'warn')
  }
)

const requireMemberForControl = () => {
  if (!isGuestIdentity.value) return true
  openNicknameDialog('当前是游客身份，只能浏览。设置昵称后才能点歌、聊天和暂停/切歌等控制。')
  return false
}

/* ---------- D-15 命令结果反馈：只承诺“已发送”，由队列/状态帧确认成功 ---------- */

/** 命令失败统一提示：游客→昵称弹层；冷却→显示剩余秒；其它→服务器 message。 */
const notifyCommandFailure = (result, label) => {
  if (!result || result.ok) return
  if (result.code === 'GUEST') {
    openNicknameDialog('请先设置昵称成为成员，然后才能点歌、聊天和控制播放。')
    return
  }
  if (result.code === 'NOOP') {
    pushToast(`${label}未发送：${result.reason || '状态未变化'}`, 'warn')
    return
  }
  if (result.code === 'OFFLINE') {
    pushToast(`${label}未发送：${result.reason || '连接已断开'}`, 'warn')
    return
  }
  const retryAfterMs = Number(result.retryAfterMs) || 0
  const cooldown = retryAfterMs > 0 ? `（${Math.ceil(retryAfterMs / 1000)} 秒后可重试）` : ''
  pushToast(`${label}失败：${result.message || result.reason || '服务器未接受'}${cooldown}`, 'warn')
}

/** 命令已发出但服务器未 ACK / 旧服务端：明确“未确认”，不得显示成功。 */
const notifyCommandSent = (result, label, successText) => {
  if (result?.confirmed) pushToast(successText || `${label}已发送，等待服务器确认`)
  else pushToast(`${label}已发送（未确认）`, 'warn')
}

/** 汇总批量命令结果（移除/置顶等）。 */
const summarizeCommandResults = (results, label, successText) => {
  const failure = results.find((item) => !item.ok)
  if (failure) {
    notifyCommandFailure(failure, label)
    return
  }
  if (results.some((item) => item.confirmed)) pushToast(successText || `${label}已发送，等待服务器确认`)
  else pushToast(`${label}已发送（未确认）`, 'warn')
}

const handleTogglePlay = async () => {
  if (!liveMode.value) {
    togglePlay()
    if (demoAudioActive.value) {
      if (playback.playing && engine.currentTime >= playback.duration) startDemoTrack(demoCurrent.value)
      else audioSyncTo(engine.currentTime, playback.playing)
    }
    return
  }
  if (!requireMemberForControl()) return
  const desired = !live.playing
  const result = await liveTogglePlay(desired)
  if (!result.ok) {
    notifyCommandFailure(result, '暂停/播放')
    return
  }
  if (!result.confirmed) pushToast('暂停/播放已发送（未确认）', 'warn')
  else pushToast('暂停/播放已发送，等待服务器确认')
  setTimeout(() => {
    if (liveMode.value && live.playing !== desired) {
      pushToast('暂停/播放未生效：可能被房间锁定，或服务器未响应', 'warn')
    }
  }, 1600)
}

const handleSkip = async () => {
  if (!liveMode.value) {
    nextDemoTrack()
    return
  }
  if (!requireMemberForControl()) return
  const before = live.nowPlaying?.id || null
  const result = await liveSkip()
  if (!result.ok) {
    notifyCommandFailure(result, '切歌')
    return
  }
  if (!result.confirmed) pushToast('切歌已发送（未确认）', 'warn')
  else pushToast('切歌已发送，等待服务器确认')
  setTimeout(() => {
    if (liveMode.value && (live.nowPlaying?.id || null) === before) {
      pushToast('切歌未生效：可能被锁定，或投票切歌未达到票数', 'warn')
    }
  }, 2200)
}

/* ---------- 本机音量 / 本机静音 ----------
   与服务器（房间）音量、操作系统音量完全解耦：
   - 房间/服务器没有音量字段，本机默认 60%，存在 localStorage（core/playback.js）；
   - 单击播放键 / 音量图标 / SPACE = 只改 APP 音频引擎（engine.setVolume/mute）；
   - 长按播放键 ≥500ms 才走房间级暂停（handleTogglePlay → 成员校验 + 服务端命令）。 */
const pauseHintOpen = ref(false)

/** 首次单击"本机静音"时弹一次说明；自动化（MP_SHOT / MP_EVAL）与已读用户不弹。 */
const showLocalMuteHint = () => {
  if (automationRun) return
  if (pauseHintOpen.value) return
  if (hasSeenLocalMuteHint()) return
  markLocalMuteHintSeen()
  pauseHintOpen.value = true
}

const dismissLocalMuteHint = () => {
  pauseHintOpen.value = false
}

/**
 * 切换本机静音（只影响 APP 媒体音量，绝不影响系统音量或房间）。
 *
 * @param {{ silent?: boolean }} [options] silent=true 时不弹提示/Toast（供 dev 参数与托盘命令用）。
 * @returns {boolean} 切换后的静音状态。
 */
const handleLocalMute = (options = {}) => {
  const muted = toggleLocalMute()
  if (muted) showLocalMuteHint()
  if (!options.silent) {
    pushToast(muted ? '本机已静音 · 不影响房间里的其他人 · 按住空格可全局暂停' : '本机声音已恢复')
  }
  return muted
}

const handleVolume = (value) => {
  const next = setLocalVolume(value)
  // 拖动音量条即视为用户想恢复声音（与主流播放器一致）
  if (next > 0 && playback.muted) playback.muted = false
  return next
}

/* App 内唯一的音量/静音出口：把本机偏好单向下发给音频引擎。 */
watch(
  () => playback.volume,
  (value) => {
    audioSetVolume(Math.max(0, Math.min(1, Number(value) / 100)))
  },
  { immediate: true }
)
watch(
  () => playback.muted,
  (muted) => {
    audioMute(Boolean(muted))
  },
  { immediate: true }
)
// 引擎侧（如托盘命令 / 未来媒体键）改了静音时回写本机状态，保持 UI 一致。
watch(
  () => engine.muted,
  (muted) => {
    if (playback.muted !== muted) playback.muted = muted
  }
)

/* ---------- 系统托盘状态同步（launcher-ipc 的 src/core/tray-bridge.js） ----------
   主窗口：把当前歌曲/封面/点赞/本机静音推给主进程（托盘卡与托盘菜单共用缓存）；
          接收托盘发来的 local-mute / like 命令并执行。
   托盘窗口（?tray=1）：只渲染 <TrayCard />，由 TrayCard 自己从 bridge 读缓存，
                        主窗口这边不推送也不订阅命令。 */
let trayCommandUnsub = null

const traySong = computed(() => (liveMode.value ? live.nowPlaying : demoCurrent.value))

/** 托盘窗口是 file:// origin：封面必须是绝对 URL；`/media/...` 用服务器 origin 解析。 */
const trayCoverUrl = computed(() => {
  const song = traySong.value
  const raw = song?.coverUrl || song?.cover?.url || ''
  if (!raw) return ''
  return audioResolveMediaUrl(raw) || ''
})

const traySnapshot = computed(() => ({
  title: traySong.value?.title || '',
  artist: traySong.value?.artist || '',
  coverUrl: trayCoverUrl.value,
  liked: Boolean(traySong.value?.likedByMe),
  muted: Boolean(playback.muted),
  playing: Boolean(playback.playing)
}))

watch(
  traySnapshot,
  (patch) => {
    if (isTrayWindow) return
    pushTrayState(patch)
  },
  { immediate: true, deep: true }
)

/** 托盘 → 主窗口命令：本地静音（只改引擎）/ 点赞（走现有 liveLike）。 */
const handleTrayCommand = async (command) => {
  const type = command && typeof command.type === 'string' ? command.type : ''
  if (type === 'local-mute') {
    handleLocalMute({ silent: true })
    pushTrayState({ muted: playback.muted })
    return
  }
  if (type === 'like') {
    if (liveMode.value && live.nowPlaying) {
      const likedSong = live.nowPlaying
      const result = await liveLike()
      if (result.ok && !addLikedSong(likedSong)) pushToast('本机收藏保存失败，请检查存储空间', 'warn')
      if (!result.ok) notifyCommandFailure(result, '点赞')
      else if (!result.confirmed) pushToast('点赞已发送（未确认）', 'warn')
      else pushToast('点赞已发送，等待服务器确认')
      pushTrayState({ liked: Boolean(live.nowPlaying?.likedByMe) })
    } else {
      if (!demoCurrent.value.likedByMe) { demoCurrent.value = { ...demoCurrent.value, likedByMe: true, liked: (demoCurrent.value.liked || 0) + 1 }; pushToast('已点赞演示歌曲') }
      else pushToast('已经为这首演示歌曲点过赞')
      pushTrayState({ liked: Boolean(demoCurrent.value.likedByMe) })
    }
  }
}

// Sample the existing analyser only while the overlay and its spectrum are visible.
// Never create another audio graph or send media over IPC.
let lyricSpectrumTimer = 0
const stopLyricSpectrum = () => { if (lyricSpectrumTimer) clearInterval(lyricSpectrumTimer); lyricSpectrumTimer = 0 }
watch(() => [desktopLyricsOpen.value, lyricStyle.spectrum], ([open, enabled]) => {
  stopLyricSpectrum()
  if (!open || !enabled || isTrayWindow || !desktopLyrics?.setSpectrum) return
  const sample = () => {
    if (engine.playing && engine.hasAnalyser) { desktopLyrics.setSpectrum(Array.from(engine.getFrequencyBins(64))); return }
    const time = performance.now() / 1000
    const fallback = Array.from({length:64}, (_, i) => {
      const envelope = barEnvelope(i,64)
      if (!engine.playing) return Math.round(255 * Math.max(.04, envelope * .2))
      const wave = .55 + .45 * Math.sin(time*1.7 + i*.42) * Math.sin(time*.63 + i*.11)
      return Math.round(255 * Math.min(1, Math.max(.04, envelope * (.35 + .75 * wave))))
    })
    desktopLyrics.setSpectrum(fallback)
  }
  sample(); lyricSpectrumTimer = setInterval(sample, 33)
}, { immediate:true })
let lyricCommandUnsub = () => {}, lyricLikeUnsub = () => {}, lyricMaterialUnsub = () => {}
let chatNotifyUnsub = () => {}
let openInstantChatUnsub = () => {}
onMounted(() => {
  if (isTrayWindow) return
  openInstantChatUnsub = window.mpDesktop?.app?.onOpenInstantChat?.((sequence) => {
    if (!live.joined) {
      pushToast('当前没有房间会话，请先加入房间查看聊天', 'warn')
      window.mpDesktop?.app?.acknowledgeInstantChat?.(sequence)
      return
    }
    active.value = 'party'
    settingsOpen.value = false
    selectedId.value = ''
    searchSelected.value = null
    historySelected.value = null
    roomInspectorSection.value = 'activity'
    inspectorOpen.value = true
    unreadChat.value = 0
    window.mpDesktop?.app?.acknowledgeInstantChat?.(sequence)
  }) || (() => {})
  lyricCommandUnsub = desktopLyrics?.onCommand?.(handleTrayCommand) || (() => {})
  lyricMaterialUnsub = desktopLyrics?.onMaterialError?.(() => pushToast('原生玻璃不可用，透明度调节可能不生效', 'warn')) || (() => {})
  lyricLikeUnsub = onRoomLike(event => {
    const person = String(event.message || '').replace(/\s*觉得很赞\s*$/, '').trim() || '有成员'
    desktopLyrics?.showLike?.({ message: `${person}：点赞了当前歌曲` })
  })
  chatNotifyUnsub = onRoomChat(message => {
    unreadChat.value = Math.min(999, unreadChat.value + 1)
    const name = String(message.user || '成员').replace(/[\r\n\t]+/g, ' ')
    pushToast(`${name.length > 30 ? name.slice(0,29) + '…' : name}：发送了一条消息`)
    window.mpDesktop?.app?.notifyChat?.({ user: message.user, text: message.text })
  })
})
onBeforeUnmount(() => { stopLyricSpectrum(); lyricCommandUnsub(); lyricLikeUnsub(); lyricMaterialUnsub(); chatNotifyUnsub(); openInstantChatUnsub() })


const handleChatSend = async (text) => {
  if (liveMode.value) {
    let result
    try { result = await liveSendChat(text) }
    catch { pushToast('发送消息失败，请重试', 'warn'); return false }
    if (!result.ok) {
      notifyCommandFailure(result, '发送消息')
      return false
    }
    if (!result.confirmed) pushToast('消息已发送（未确认）', 'warn')
    else pushToast('消息已发送，等待服务器确认')
    return true
  }
  const now = new Date()
  demoChat.push({
    id: `m-${Date.now()}`,
    type: 'chat',
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    user: '游客',
    me: true,
    text
  })
  return true
}

watch(
  () => [liveMode.value, live.playing],
  ([isLive, value]) => {
    if (isLive) playback.playing = value
  },
  { immediate: true }
)

watch(
  () => live.progress,
  (value) => {
    if (liveMode.value) playback.progress = Math.round(value)
  }
)

// Clear demo selections + real filters when the live session starts/stops; also make
// sure live rooms never land on unsupported pages (历史/假控制台).
watch(liveMode, () => {
  selectedId.value = ''
  searchSelected.value = null
  historySelected.value = null
  queueFilter.value = 'all'
  queueSource.value = 'all'
  chatFilter.value = 'all'
  roomInspectorSection.value = 'all'
  // D-14：会话结束后（主动离开/内部 teardown/换房）无条件清理本地音频，避免残留播放。
  if (!liveMode.value) cleanupLiveAudio()
  if (liveMode.value && active.value === 'history') {
    active.value = 'party'
    pushToast('实时房间暂不支持历史记录（服务端没有历史接口）', 'warn')
  }
  if (liveMode.value && active.value === 'console' && !adminAuthed.value) {
    active.value = 'party'
  }
})

// Joining a room without admin rights hides the console: never leave the user
// stranded on a page that is no longer reachable.
watch(consoleLocked, (locked) => {
  if (locked && active.value === 'console') {
    active.value = 'party'
    pushToast('已加入房间：控制台仅对管理员开放', 'warn')
  }
})

watch(
  () => live.nowPlaying?.id,
  () => {
    if (!liveMode.value || !live.nowPlaying) {
      // 当前歌曲消失：清掉残留歌词（在途请求由 api 层序号/会话代次丢弃）。
      live.lyrics = []
      return
    }
    playback.progress = Math.round(live.progress || 0)
    // 试听片段：UI 提示实际可播时长，避免误以为能播完整首（S-01/协议 v2）。
    if (live.nowPlaying.trial) {
      const seconds = live.nowPlaying.playableDuration || live.nowPlaying.duration
      pushToast(live.nowPlaying.trialDurationKnown ? `试听片段 · 仅可播放 ${formatSongTime(seconds)}（非完整曲目）` : '试听片段 · 可播时长未确定', 'warn')
    }
    void liveGetLyrics(live.nowPlaying)
  }
)

/* ---------- real audio engine wiring ---------- */
watch(
  [() => live.nowPlaying?.id, () => live.nowPlaying?.source, () => live.nowPlaying?.url, () => live.playbackId, () => liveMode.value],
  () => {
    mediaRecovery.reset()
    if (!liveMode.value) return
    if (!live.nowPlaying) {
      audioPause()
      audioSetTrack(null)
      return
    }
    // D-12/D-16：媒体相对地址必须用当前会话 base 解析，不能用可变展示 host。
    const baseUrl = live.sessionBase || httpBase()
    audioSetBaseUrl(baseUrl)
    audioSetTrack({
      url: live.nowPlaying.url,
      // 试听片段用实际可播时长锚定，不得按整曲时长伪造进度（S-01）。
      duration: live.nowPlaying.playableDuration || live.nowPlaying.duration,
      startAt: live.progress || 0,
      baseUrl
    })
    audioSyncTo(live.progress || 0, live.playing)
  }
)

watch(() => engine.error, (error) => {
  if (liveMode.value && error) {
    if (!/需要用户交互/.test(error)) mediaRecovery.request()
    pushToast(`音频播放失败：${error}`, 'warn')
  }
})

watch(
  () => [live.progress, live.playing],
  ([progress, playing]) => {
    if (liveMode.value) audioSyncTo(progress, playing)
  }
)

watch(
  () => engine.currentTime,
  (time) => {
    if (demoShell.value && demoAudioActive.value && engine.ready) {
      playback.progress = Math.round(time)
    }
    if (liveMode.value && engine.ready && time > 0) {
      playback.progress = Math.round(time)
    }
  }
)

watch(() => [engine.currentTime, engine.playing], ([time, playing]) => {
  if (demoShell.value && demoAudioActive.value && engine.ready && !playing && engine.duration > 0 && time >= engine.duration - 0.05 && playback.playing) nextDemoTrack()
})

const roomView = computed(() => {
  if (liveMode.value) {
    return {
      name: live.roomName || '房间',
      code: live.roomCode || '—',
      mode: live.connected ? '实时' : '重连中',
      server: live.server,
      online: live.online || 0,
      capacity: live.capacity || 0,
      latency: live.latency || 0,
      locked: live.locked,
      admin: false,
      queueCount: live.queue.length,
      historyCount: 0
    }
  }
  return { ...demo.room, queueCount: queue.length }
})
const neteaseCount = computed(() => queueView.value.filter((s) => s.source === 'netease').length)
const biliCount = computed(() => queueView.value.filter((s) => s.source === 'bilibili').length)
const myName = computed(() => {
  if (liveMode.value) {
    const you = live.members.find((m) => m.you)
    if (you?.name) return you.name
  }
  return joinForm.name || '游客'
})
const isMyRequest = (item) =>
  Boolean(item.requestedBy) &&
  (item.requestedBy === myName.value || item.requestedBy === '你' || item.requestedBy === '游客')
const mineCount = computed(() => queueView.value.filter(isMyRequest).length)
const pinnedCount = computed(() => queueView.value.filter((s) => s.pinned).length)
/** 真实客户端过滤：队列（全部/我的点歌/置顶 + 来源）。 */
const filteredQueueView = computed(() =>
  queueView.value.filter((item) => {
    if (queueFilter.value === 'mine' && !isMyRequest(item)) return false
    if (queueFilter.value === 'pinned' && !item.pinned) return false
    if (queueSource.value !== 'all' && item.source !== queueSource.value) return false
    return true
  })
)
const chatSystemCount = computed(() => chatMessages.value.filter((m) => m.type === 'system').length)
const chatMeCount = computed(() => chatMessages.value.filter((m) => m.me).length)
/** 真实客户端过滤：聊天（全部/系统/我）。 */
const filteredChatMessages = computed(() =>
  chatMessages.value.filter((m) => {
    if (chatFilter.value === 'system') return m.type === 'system'
    if (chatFilter.value === 'me') return Boolean(m.me)
    return true
  })
)

/* ---------- D-01：检查器选中跟随队列变化 ----------
   必须在 filteredQueueView 及其依赖（isMyRequest/myName/queueFilter/queueSource）全部定义
   之后再创建 watcher：watch 会立即执行 getter 收集依赖，提前创建会命中 TDZ
   （ReferenceError: Cannot access 'filteredQueueView' before initialization）并导致
   自动选中永远不生效（加入合成歌曲后右侧仍停留在“房间检查器”）。
   场景覆盖：演示切实时、队列清空/替换、删除当前项、修改筛选。 */
watch(
  () => filteredQueueView.value.map((s) => s.id).join('|'),
  () => {
    const list = filteredQueueView.value
    if (list.some((s) => s.id === selectedId.value)) return
    const first = list.find((s) => s.state === 'playing') || list[0]
    selectedId.value = first ? first.id : ''
  }
)
const queueFilterOptions = [
  { id: 'all', label: '全部队列', icon: ListMusic },
  { id: 'mine', label: '我的点歌', icon: UserRound },
  { id: 'pinned', label: '置顶', icon: Pin }
]

const isNarrow = () => window.innerWidth < 1240
const inspectorOpen = ref(!isNarrow())
let wasNarrow = isNarrow()

const onResize = () => {
  const narrow = isNarrow()
  if (narrow !== wasNarrow) {
    inspectorOpen.value = !narrow
    wasNarrow = narrow
  }
}
const spaceHolding = ref(false)
const spaceProgress = ref(false)
let spaceStarted = 0, spaceDelay = 0, spaceTimer = 0, spaceTriggered = false, spaceButton = null
const cancelSpace = () => { clearTimeout(spaceDelay); clearTimeout(spaceTimer); spaceHolding.value = false; spaceProgress.value = false; spaceStarted = 0; spaceButton = null }
watch(() => [showOnboarding.value, settingsOpen.value, paletteOpen.value, joinOpen.value, !!confirmState.value, adminOpen.value, adminAuthOpen.value, closePromptOpen.value, tutorialActive.value, helpOpen.value, nicknameOpen.value], (flags) => { if (flags.some(Boolean)) cancelSpace() })
const onKeyup = (event) => {
  if (document.querySelector('.notice-dialog')) { cancelSpace(); return }
  if ((event.code !== 'Space' && event.key !== ' ') || !spaceStarted) return
  event.preventDefault()
  const elapsed = performance.now() - spaceStarted
  const fired = spaceTriggered
  const button = spaceButton
  cancelSpace()
  if (!fired && elapsed < 200) { if (button?.isConnected && !button.disabled) button.click(); else handleLocalMute() }
}
const onKeydown = (event) => {
  if (document.querySelector('.notice-dialog')) return
  if (event.isComposing || event.keyCode === 229) return
  const mod = event.ctrlKey || event.metaKey
  const el = document.activeElement
  const typing = el && (el.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || el.closest?.('[contenteditable=true], [role=textbox]'))

  // Admin overlays own the keyboard (AdminAuthDialog / AdminView handle Escape
  // internally); never let CTRL K / SPACE / arrows leak into the shell behind them.
  if (adminOpen.value || adminAuthOpen.value) return

  // 关闭询问弹窗优先级最高：Esc = 取消，其余按键不穿透到应用。
  if (closePromptOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      respondClose('cancel')
    }
    return
  }

  if (clearingLocalData.value) { event.preventDefault(); return }
  // The spotlight tutorial owns the keyboard while it is open (TutorialOverlay
  // handles ESC / ← / → / Enter itself).
  if (tutorialActive.value || helpOpen.value) return

  // The onboarding page only responds to settings / escape; shell shortcuts would
  // act on hidden demo panels.
  if (showOnboarding.value) {
    if (mod && event.key === ',') {
      event.preventDefault()
      settingsOpen.value = true
    } else if (event.key === 'Escape' && settingsOpen.value) {
      settingsOpen.value = false
    }
    return
  }

  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    paletteInitialQuery.value = ''
    paletteOpen.value = true
    return
  }
  if (mod && event.key === ',') {
    event.preventDefault()
    settingsOpen.value = true
    return
  }
  if (event.key === 'Escape') {
    if (paletteOpen.value) paletteOpen.value = false
    else if (confirmState.value) confirmState.value = null
    else if (joinOpen.value) joinOpen.value = false
    else if (settingsOpen.value) settingsOpen.value = false
    return
  }
  if (typing) return
  if (confirmState.value && event.key === 'Enter') {
    event.preventDefault()
    runConfirm()
    return
  }
  if (event.key === ' ') {
    if (spaceStarted) { event.preventDefault(); return }
    if (event.repeat || mod || event.altKey || event.shiftKey || settingsOpen.value || paletteOpen.value || joinOpen.value || confirmState.value) return
    event.preventDefault()
    spaceButton = el?.closest?.('button') || null
    spaceStarted = performance.now(); spaceTriggered = false
    spaceDelay = setTimeout(() => { spaceProgress.value = true; spaceHolding.value = true }, 200)
    spaceTimer = setTimeout(() => { spaceTriggered = true; spaceHolding.value = false; spaceProgress.value = false; void handleTogglePlay() }, 1000)
  } else if (mod && event.key === 'ArrowRight') {
    event.preventDefault()
    // 真实切歌（游客/游客身份按 handleSkip 的规则弹昵称提示或失败提示），不再是「下一首（演示）」假 toast。
    handleSkip()
  }
}

onMounted(() => {
  // 托盘小窗口只渲染 <TrayCard />：不注册全局壳监听、不读 dev 参数、不建立连接逻辑。
  if (isTrayWindow) return

  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', cancelSpace)
  window.addEventListener('resize', onWindowResize)

  /* 主进程 IPC：关闭询问（渲染层三选一）+ 托盘命令转发。
     preload 尚未就绪（纯浏览器预览 / 旧构建）时全部降级为 no-op。 */
  try {
    const offClose = window.mpDesktop?.window?.onCloseRequest?.((payload) => onCloseRequest(payload))
    closeRequestUnsub = typeof offClose === 'function' ? offClose : null
  } catch {
    closeRequestUnsub = null
  }
  trayCommandUnsub = onTrayCommand(handleTrayCommand)

  if (initialParams.get('palette') === '1') paletteOpen.value = true
  if (initialParams.get('confirm') === '1') {
    askConfirm({
      title: '移除歌曲？',
      text: '示例确认框：确认后会同步到房间内所有人。',
      confirmLabel: '移除',
      danger: true,
      onConfirm: () => {}
    })
  }
  if (initialParams.get('offline') === '1') goOffline({ autoRecover: false })
  if (initialParams.get('toast') === '1') pushToast('已加入队列 · 测试音轨 01')
  if (initialParams.get('join') === '1') openJoinDialog()
  if (initialParams.get('view') === 'settings') settingsOpen.value = true

  /* 本机音频状态 dev 参数（截图/自动化用）：
     ?muted=1 渲染"本机静音"状态；?volume=35 指定本机音量；?hint=1 展示长按说明气泡。 */
  if (initialParams.get('muted') === '1') playback.muted = true
  if (initialParams.get('volume') != null) setLocalVolume(initialParams.get('volume'))
  if (initialParams.get('hint') === '1') pauseHintOpen.value = true

  // Demo data is opt-in: a normal launch stays on the onboarding page. Automation
  // runs explicitly request the shell via ?shot / ?eval / ?demo / ?live / ?join / ?view.
  if (initialParams.get('demo') === '1') showOnboarding.value = false
  if (initialParams.get('welcome') === '1') showOnboarding.value = true
  if (initialParams.get('tutorial') === '1') {
    const startStep = Number(initialParams.get('tutorialStep') || 0) || 0
    setTimeout(() => startTutorial(startStep), 500)
  }
  if (initialParams.get('nickname') === '1') {
    nicknameOpen.value = true
    nicknameError.value = '当前是游客身份，只能浏览；设置昵称后才能点歌、聊天和控制播放。'
  }
  if (initialParams.get('live') === '1') {
    joinForm.serverUrl = initialParams.get('server') || joinForm.serverUrl
    joinForm.name = initialParams.get('name') || '游客'
    joinForm.password = initialParams.get('password') || ''
    if (!initialParams.get('view')) active.value = 'party'
    setTimeout(() => void doJoin(), 120)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  window.removeEventListener('blur', cancelSpace)
  cancelSpace()
  try {
    disposeSessionLifecycle?.()
  } catch {
    /* ignore */
  }
  try {
    closeRequestUnsub?.()
  } catch {
    /* ignore */
  }
  closeRequestUnsub = null
  try {
    trayCommandUnsub?.()
  } catch {
    /* ignore */
  }
  trayCommandUnsub = null
})

watch(
  active,
  (view) => {
    if (view === 'queue' && !selectedId.value) {
      const playing = queue.find((s) => s.state === 'playing')
      selectedId.value = playing?.id || queue[0]?.id || ''
    }
    if (view === 'search' && !searchSelected.value) {
      searchSelected.value = liveMode.value ? null : demo.searchResults[0]
    }
    if (view === 'history' && !historySelected.value) {
      historySelected.value = liveMode.value ? null : demo.history[0]
    }
    if (view !== 'queue') selectedId.value = ''
    if (view !== 'search') searchSelected.value = null
    if (view !== 'history') historySelected.value = null
  },
  { immediate: true }
)

/* ---------- sidebar config（新 IA：房间 → 当前页 → 快捷；见 docs/SIDEBAR_REDESIGN.md） ---------- */
const roomSidebarGroup = computed(() => {
  const online = roomView.value.online || 0
  const capacity = roomView.value.capacity || 0
  return {
    tone: 'room',
    title: '房间 · ROOM',
    tag: liveMode.value ? (capacity ? `${online}/${capacity}` : `${online} 人`) : `演示 · ${online}`,
    roomCard: true,
    items: [
      {
        id: 'room-info',
        label: '房间信息',
        icon: ListMusic,
        active: roomInspectorSection.value === 'info',
        tooltip: '在右侧检查器查看房间信息'
      },
      {
        id: 'room-people',
        label: '成员列表',
        count: membersView.value.length,
        icon: Headphones,
        active: roomInspectorSection.value === 'members'
      },
      {
        id: 'room-log',
        label: '即时聊天',
        count: instantChatMessages.value.filter(m => m.type === 'chat' || m.type === 'song').length,
        unread: unreadChat.value > 0,
        icon: MessageSquare,
        active: roomInspectorSection.value === 'activity'
      }
    ]
  }
})

const queueContextGroups = computed(() => [
  {
    tone: 'context',
    title: '筛选 · FILTER',
    tag: String(filteredQueueView.value.length),
    items: [
      {
        id: 'queue-filter-all',
        label: '全部队列',
        icon: ListMusic,
        active: !showLikedSongs.value && queueFilter.value === 'all',
        count: queueView.value.length
      },
      {
        id: 'queue-filter-mine',
        label: '我的点歌',
        icon: UserRound,
        active: !showLikedSongs.value && queueFilter.value === 'mine',
        count: mineCount.value
      },
      {
        id: 'queue-filter-pinned',
        label: '置顶',
        icon: Pin,
        active: !showLikedSongs.value && queueFilter.value === 'pinned',
        count: pinnedCount.value
      }
    ]
  },
  {
    tone: 'context',
    title: '来源 · SOURCE',
    tag: String(filteredQueueView.value.length),
    items: [
      {
        id: 'queue-source-all',
        label: '全部来源',
        icon: Layers,
        active: !showLikedSongs.value && queueSource.value === 'all',
        count: queueView.value.length
      },
      {
        id: 'queue-source-netease',
        label: '网易云音乐',
        icon: Music2,
        active: !showLikedSongs.value && queueSource.value === 'netease',
        count: neteaseCount.value
      },
      {
        id: 'queue-source-bilibili',
        label: 'Bilibili',
        icon: Video,
        active: !showLikedSongs.value && queueSource.value === 'bilibili',
        count: biliCount.value
      }
    ]
  }
])

const chatContextGroups = computed(() => [
  {
    tone: 'context',
    title: '筛选 · FILTER',
    tag: String(filteredChatMessages.value.length),
    items: [
      {
        id: 'chat-filter-all',
        label: '全部消息',
        icon: MessageSquare,
        active: chatFilter.value === 'all',
        count: chatMessages.value.length
      },
      {
        id: 'chat-filter-system',
        label: '系统消息',
        icon: Activity,
        active: chatFilter.value === 'system',
        count: chatSystemCount.value
      },
      {
        id: 'chat-filter-me',
        label: '我发送的',
        icon: UserRound,
        active: chatFilter.value === 'me',
        count: chatMeCount.value
      }
    ]
  }
])

const noteGroup = (title, label) => ({
  tone: 'context',
  title,
  items: [{ id: `${title}-note`, note: true, label }]
})

const formatSongTime = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Party 页的「接下来」：真实队列数据（不是视图筛选），让侧栏有空时也有实际内容，
 * 点击直接跳到队列并选中该曲目。
 */
const partyUpNextGroup = computed(() => {
  const list = queueView.value.filter((song) => song.state !== 'playing').slice(0, 15)
  return {
    tone: 'context',
    title: '接下来 · UP NEXT',
    tag: String(list.length),
    items: list.map((song) => ({
      id: `song:${song.id}`,
      label: song.title,
      icon: Music2,
      count: formatSongTime(song.duration),
      subtitle: song.artist || '未知歌手',
      requestedBy: song.requestedBy || '未知成员'
    })).concat([{ id: 'show-all-queue', label: '查看完整队列', icon: ListMusic }])
  }
})

/** 快捷组：≤3 条，且不与 NavRail/标题栏/账户菜单重复（管理终端只有这里可达）。 */
const quickSidebarGroup = computed(() => {
  const items = []
  if (liveMode.value && adminAuthed.value) {
    items.push({
      id: 'open-admin-console',
      label: '打开管理终端',
      icon: ShieldCheck,
      tooltip: '已认证 · 打开真实管理面板'
    })
  }
  return items.length ? { tone: 'quick', title: '快捷 · QUICK', items } : null
})

const sidebar = computed(() => {
  const groups = [roomSidebarGroup.value]
  if (active.value === 'party') {
    const upNext = partyUpNextGroup.value
    if (upNext) groups.push(upNext)
  }
  if (active.value === 'queue') {
    groups.push(...queueContextGroups.value)
    groups.push({ tone: 'context', title: '收藏 · LIKES', items: [{ id: 'liked-songs', label: '赞过的歌曲', icon: Heart, count: likedSongs.value.length, active: showLikedSongs.value }] })
  }
  if (active.value === 'chat') groups.push(...chatContextGroups.value)
  if (active.value === 'history') {
    groups.push(noteGroup('说明 · NOTE', '演示数据 · 服务端没有历史接口，真实房间不提供历史页'))
  }
  if (active.value === 'console') {
    groups.push(noteGroup('说明 · NOTE', '演示预览 · 真实管理在「管理员认证 → 管理终端」中'))
  }
  const quick = quickSidebarGroup.value
  if (quick) groups.push(quick)

  let create = null
  if (active.value === 'party') {
    create = {
      id: 'copy-server',
      label: '复制服务器地址',
      title: '服务端没有邀请链接：把服务器地址 + 房间密码发给朋友即可'
    }
  }
  if (active.value === 'queue') {
    create = { id: 'go-search', label: '点歌', title: '前往搜索页点歌' }
  }
  return { groups, create }
})

/** 从接下来进入完整队列：不能沿用可能隐藏目标歌曲的筛选或收藏页。 */
const openFullQueue = (songId = '') => {
  showLikedSongs.value = false
  queueFilter.value = 'all'
  queueSource.value = 'all'
  selectedId.value = songId
  active.value = 'queue'
}

/** 侧栏动作分发：每个 id 都必须在这里有真实分支（未实现的条目不会出现在 groups 里）。 */
const handleSidebarSelect = (id) => {
  if (id === 'liked-songs') { showLikedSongs.value = true; active.value = 'queue'; return }
  if (id === 'show-all-queue') { openFullQueue(); return }
  if (id.startsWith('song:')) {
    openFullQueue(id.slice('song:'.length))
    return
  }
  if (id === 'room-info' || id === 'room-people' || id === 'room-log') {
    if (id === 'room-log') { selectedId.value = ''; searchSelected.value = null; historySelected.value = null; unreadChat.value = 0 }
    roomInspectorSection.value = id === 'room-info' ? 'info' : id === 'room-people' ? 'members' : 'activity'
    inspectorOpen.value = true
    return
  }
  if (id.startsWith('queue-filter-')) {
    showLikedSongs.value = false
    const value = id.slice('queue-filter-'.length)
    if (!['all', 'mine', 'pinned'].includes(value)) return
    queueFilter.value = value
    active.value = 'queue'
    return
  }
  if (id.startsWith('queue-source-')) {
    showLikedSongs.value = false
    const value = id.slice('queue-source-'.length)
    if (!['all', 'netease', 'bilibili'].includes(value)) return
    queueSource.value = value
    active.value = 'queue'
    return
  }
  if (id.startsWith('chat-filter-')) {
    const value = id.slice('chat-filter-'.length)
    if (!['all', 'system', 'me'].includes(value)) return
    chatFilter.value = value
    active.value = 'chat'
    return
  }
  if (id === 'copy-server') {
    copyServerAddress()
    return
  }
  if (id === 'go-search') {
    active.value = 'search'
    return
  }
  if (id === 'open-settings') {
    settingsOpen.value = true
    return
  }
  if (id === 'open-admin-console') {
    openAdminPanel()
  }
}

/* ---------- command bar config（去装饰化：只保留真实分段/主操作） ---------- */
const command = computed(() => {
  if (active.value === 'party') {
    return {
      title: '派对现场',
      kicker: liveMode.value
        ? `LIVE ROOM · ${live.server} · ${live.online} 人在线`
        : `DEMO · ${demo.room.name} · ${demo.room.online} 人在线（演示数据）`,
      segments: [],
      activeSegment: '',
      actionLabel: '复制服务器地址',
      actionTitle: '复制服务器地址（再把房间密码告诉朋友即可加入）'
    }
  }
  if (active.value === 'queue') {
    if (showLikedSongs.value) return { title: '赞过的歌曲', kicker: `LIKESONG · 本机收藏 · ${likedSongs.value.length} 首`, segments: [], activeSegment: '', actionLabel: '点歌', actionTitle: '前往搜索页点歌' }
    const filterLabel =
      queueFilter.value === 'all' ? '全部队列' : queueFilter.value === 'mine' ? '我的点歌' : '置顶'
    return {
      title: '队列',
      kicker: `QUEUE · ${filteredQueueView.value.length}/${queueView.value.length} 首 · ${filterLabel} · ${
        liveMode.value ? `${live.online} 人在线` : '演示数据'
      }`,
      segments: [
        { id: 'all', label: '全部' },
        { id: 'mine', label: '我的点歌' },
        { id: 'pinned', label: '置顶' }
      ],
      activeSegment: queueFilter.value,
      actionLabel: '点歌',
      actionTitle: '前往搜索页点歌'
    }
  }
  if (active.value === 'search') {
    return {
      title: '搜索',
      kicker: liveMode.value ? 'SEARCH · 网易云 / Bilibili · 实时' : 'SEARCH · 网易云 / Bilibili（演示数据）',
      segments: [],
      activeSegment: '',
      actionLabel: ''
    }
  }
  if (active.value === 'chat') {
    return {
      title: '聊天',
      kicker: `CHAT · ${filteredChatMessages.value.length}/${chatMessages.value.length} 条 · ${
        liveMode.value ? `${live.online} 人在线` : '演示数据'
      }`,
      segments: [
        { id: 'all', label: '全部' },
        { id: 'system', label: '系统' },
        { id: 'me', label: '我' }
      ],
      activeSegment: chatFilter.value,
      actionLabel: ''
    }
  }
  if (active.value === 'history') {
    return {
      title: '历史',
      kicker: liveMode.value
        ? '服务端没有历史接口'
        : `HISTORY · 演示数据 · ${demo.history.length} 条（非真实房间记录）`,
      segments: [],
      activeSegment: '',
      actionLabel: ''
    }
  }
  if (active.value === 'console') {
    return {
      title: '控制台',
      kicker: liveMode.value
        ? '管理能力在管理终端（管理员认证后）'
        : 'CONSOLE · DEMO 演示预览 · 真实管理在管理终端',
      segments: [],
      activeSegment: '',
      actionLabel: ''
    }
  }
  if (active.value === 'states') {
    return {
      title: '状态示例',
      kicker: 'DEV · STATE GALLERY · 空 / 加载 / 错误 / 无结果',
      segments: [],
      activeSegment: '',
      actionLabel: '返回派对'
    }
  }
  const nav = navItems.find((n) => n.id === active.value)
  return { title: nav?.label || '派对', kicker: '', segments: [], activeSegment: '', actionLabel: '' }
})

/** 命令栏分段 → 真实筛选状态（队列/聊天）。 */
const handleSegment = (id) => {
  if (active.value === 'queue' && ['all', 'mine', 'pinned'].includes(id)) { showLikedSongs.value = false; queueFilter.value = id }
  if (active.value === 'chat' && ['all', 'system', 'me'].includes(id)) chatFilter.value = id
}

/* ---------- queue mutations ---------- */
const likeItem = (item) => {
  if (item.likedByMe) {
    item.likedByMe = false
    item.liked = Math.max(0, item.liked - 1)
  } else {
    item.likedByMe = true
    item.liked += 1
  }
}

const topItem = (item) => {
  const from = queue.indexOf(item)
  if (from < 0) return
  queue.splice(from, 1)
  const playing = queue.findIndex((s) => s.state === 'playing')
  queue.splice(playing >= 0 ? playing + 1 : 0, 0, item)
}

const removeIds = (ids) => {
  const set = new Set(ids)
  for (let i = queue.length - 1; i >= 0; i--) {
    if (set.has(queue[i].id)) queue.splice(i, 1)
  }
  if (set.has(selectedId.value)) selectedId.value = ''
}

const copySong = (item) => {
  const text = `${item.title} - ${item.artist}（${item.sourceLabel}）`
  copyText(text)
  pushToast('已复制歌曲信息')
}

let refreshingList = false
const refreshList = async () => {
  if (refreshingList || !live.connected) return
  refreshingList = true
  const base = live.sessionBase
  const generation = session.generation
  try {
    const snapshot = await getRoomSnapshot({ requireFresh: true })
    if (!live.connected || live.sessionBase !== base || session.generation !== generation) return
    if (!snapshot) { pushToast('未能刷新房间状态，请稍后重试', 'warn'); return }
    if (live.loading) { pushToast('歌曲正在加载，请稍候') ; return }
    if (!live.nowPlaying && live.queue.length) {
      const result = await liveTogglePlay(true)
      if (!result.ok) notifyCommandFailure(result, '启动播放')
      else pushToast('已请求启动待播歌曲，请查看房间状态')
    } else pushToast(live.nowPlaying ? '房间状态已更新' : '队列仍为空，请先点歌')
  } catch { pushToast('刷新房间状态失败，请稍后重试', 'warn') }
  finally { refreshingList = false }
}

const addToQueue = async (song) => {
  if (liveMode.value) {
    // D-15：只显示“已发送/等待确认/失败原因”；队列帧到达后才算真正点歌成功。
    const result = await liveAddToQueue(song)
    if (!result.ok) {
      notifyCommandFailure(result, '点歌')
      return
    }
    if (result.confirmed) pushToast(`已加入队列 · ${song.title}`)
    else pushToast(`点歌已发送（未确认）· ${song.title}`, 'warn')
    return
  }
  const now = new Date()
  const addedAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  queue.push({
    ...song,
    id: `q-${Date.now()}`,
    state: 'queued',
    pinned: false,
    liked: 0,
    likedByMe: false,
    requestedBy: '游客',
    addedAt
  })
  pushToast(`已加入队列 · ${song.title}`)
}

const handleSearchAction = (action) => {
  if (!searchSelected.value) return
  if (action === 'add') addToQueue(searchSelected.value)
  else if (action === 'copy') copySong(searchSelected.value)
}

const handleHistoryAction = (action) => {
  if (!historySelected.value) return
  if (action === 'add') addToQueue(historySelected.value)
  else if (action === 'copy') copySong(historySelected.value)
}

const handleQueueAction = async (payload) => {
  if (liveMode.value) {
    const items = queueView.value
    if (payload.ids) {
      const ids = payload.ids
      const picked = items.filter((s) => ids.includes(s.id))
      if (payload.action === 'remove') {
        askConfirm({
          title: `移除 ${picked.length} 首歌曲？`,
          text: '将把这些歌曲从播放队列中移除，操作会同步到房间内所有人。',
          confirmLabel: '移除',
          danger: true,
          onConfirm: async () => {
            const results = await Promise.all(picked.map((item) => liveRemoveFromQueue(item)))
            summarizeCommandResults(results, '移除歌曲')
          }
        })
      } else if (payload.action === 'pin') {
        const results = await Promise.all(picked.map((item) => livePin(item)))
        summarizeCommandResults(results, '置顶')
      } else if (payload.action === 'like') {
        const result = await liveLike()
        if (!result.ok) notifyCommandFailure(result, '点赞')
        else notifyCommandSent(result, '点赞')
      }
      return
    }

    const { action, item } = payload
    if (!item) return
    if (action === 'claim') {
      askConfirm({ title: '认领此成员的歌单？', text: `将认领 ${item.requestedBy || '该成员'} 尚在队列中的歌曲，并使用该成员昵称。`, confirmLabel: '认领',
        onConfirm: async () => {
          const result = await liveClaimPlaylist(item)
          if (!result.ok) notifyCommandFailure(result, '认领歌单')
          else pushToast(result.message || `已认领 ${result.claimed} 首歌曲`)
        } })
    } else if (action === 'top' || action === 'pin') {
      const result = await livePin(item)
      if (!result.ok) notifyCommandFailure(result, '置顶')
      else notifyCommandSent(result, '置顶')
    } else if (action === 'unpin') {
      pushToast('服务端不支持取消置顶', 'warn')
    } else if (action === 'like') {
      if (live.nowPlaying && item.id === live.nowPlaying.id) {
        const result = await liveLike(item)
        if (!result.ok) notifyCommandFailure(result, '点赞')
        else notifyCommandSent(result, '点赞')
      } else {
        pushToast('只能点赞当前播放的歌曲', 'warn')
      }
    } else if (action === 'remove') {
      askConfirm({
        title: '移除这首歌？',
        text: `将把《${item.title}》从播放队列中移除，操作会同步到房间内所有人。`,
        confirmLabel: '移除',
        danger: true,
        onConfirm: async () => {
          const result = await liveRemoveFromQueue(item)
          if (!result.ok) notifyCommandFailure(result, '移除歌曲')
          else notifyCommandSent(result, '移除歌曲')
        }
      })
    } else if (action === 'copy') {
      copySong(item)
    }
    return
  }

  if (payload.ids) {
    const ids = payload.ids
    if (payload.action === 'pin') {
      ids.forEach((id) => {
        const item = queue.find((s) => s.id === id)
        if (item) item.pinned = true
      })
      pushToast(`已置顶 ${ids.length} 首歌`)
    } else if (payload.action === 'like') {
      ids.forEach((id) => {
        const item = queue.find((s) => s.id === id)
        if (item && !item.likedByMe) likeItem(item)
      })
      pushToast(`已点赞 ${ids.length} 首歌`)
    } else if (payload.action === 'remove') {
      askConfirm({
        title: `移除 ${ids.length} 首歌曲？`,
        text: '将把这些歌曲从播放队列中移除，操作会同步到房间内所有人。',
        confirmLabel: '移除',
        danger: true,
        onConfirm: () => {
          removeIds(ids)
          pushToast(`已移除 ${ids.length} 首歌`)
        }
      })
    }
    return
  }

  const { action, item } = payload
  if (!item) return
  if (action === 'top') {
    topItem(item)
    pushToast('已置顶到队首')
  } else if (action === 'pin') {
    item.pinned = true
    pushToast('已置顶')
  } else if (action === 'unpin') {
    item.pinned = false
    pushToast('已取消置顶')
  } else if (action === 'like') {
    likeItem(item)
    pushToast(item.likedByMe ? '已点赞' : '已取消点赞')
  } else if (action === 'remove') {
    askConfirm({
      title: '移除这首歌？',
      text: `将把《${item.title}》从播放队列中移除，操作会同步到房间内所有人。`,
      confirmLabel: '移除',
      danger: true,
      onConfirm: () => {
        removeIds([item.id])
        pushToast('已从队列移除')
      }
    })
  } else if (action === 'copy') {
    copySong(item)
  }
}

const handleReorder = async ({ next, moved }) => {
  if (liveMode.value) {
    const result = await liveReorderQueue(next, moved)
    pushToast(result.ok ? '排序请求已发送，等待房间同步' : (result.reason || result.message || '排序失败'), result.ok ? 'info' : 'warn')
    return
  }
  queue.splice(0, queue.length, ...next)
}

const handleRoomMode = async mode => {
  const result = await liveSetPlayMode(mode)
  pushToast(result.ok ? '播放模式请求已发送' : (result.reason || result.message || '无法切换播放模式'), result.ok ? 'info' : 'warn')
}
const handleRoomSeek = async ({ seconds, playbackId }) => {
  const result = await liveSeekRoom(seconds, playbackId)
  if (!result.ok) pushToast(result.reason || result.message || '无法调整播放进度', 'warn')
}

const handleCommandPrimary = () => {
  if (active.value === 'party') {
    copyServerAddress()
  } else if (active.value === 'queue') {
    active.value = 'search'
  } else if (active.value === 'states') {
    active.value = 'party'
  }
}

const toggleInspector = () => {
  inspectorOpen.value = !inspectorOpen.value
}

/** 房间检查器真实动作（P1-8）：复制服务器地址 / 打开队列。 */
const handleRoomInspectorAction = (action) => {
  if (action === 'copy-server') {
    copyServerAddress()
    return
  }
  if (action === 'open-queue') {
    active.value = 'queue'
  }
}

const onWindowResize = () => {}

const handleInspectorAction = (action) => {  if (!selectedSong.value) return
  if (action === 'copy') {
    copySong(selectedSong.value)
  } else if (action === 'remove') {
    const song = selectedSong.value
    askConfirm({
      title: '移除这首歌？',
      text: `将把《${song.title}》从播放队列中移除，操作会同步到房间内所有人。`,
      confirmLabel: '移除',
      danger: true,
      onConfirm: async () => {
        if (liveMode.value) {
          const result = await liveRemoveFromQueue(song)
          if (!result.ok) notifyCommandFailure(result, '移除歌曲')
          else notifyCommandSent(result, '移除歌曲')
        } else {
          removeIds([song.id])
          pushToast('已从队列移除')
        }
      }
    })
  } else {
    handleQueueAction({ action, item: selectedSong.value })
  }
}

// Debug handle for QA / eval harnesses (read-only usage).
if (typeof window !== 'undefined') {
  window.__mp = {
    live,
    engine,
    playback,
    onboarding: {
      visible: () => showOnboarding.value,
      demo: () => demoShell.value,
      advanced: onboardingAdvanced
    },
    tour: {
      open: () => tutorialActive.value,
      step: () => tutorialStepNow.value,
      start: (step = 0) => startTutorial(step)
    },
    admin: {
      locked: () => consoleLocked.value,
      authed: () => adminAuthed.value,
      verified: () => Boolean(adminAuth.verified),
      open: () => adminOpen.value,
      authOpen: () => adminAuthOpen.value
    },
    /** 侧栏筛选/检查器状态（截图与交互测试用，只读 getter）。 */
    ui: {
      queueFilter: () => queueFilter.value,
      queueSource: () => queueSource.value,
      chatFilter: () => chatFilter.value,
      roomInspectorSection: () => roomInspectorSection.value,
      filteredQueueCount: () => filteredQueueView.value.length,
      filteredChatCount: () => filteredChatMessages.value.length
    },
    /** 本机音量/静音（只影响 APP 音频引擎）——截图与交互测试用。 */
    localAudio: {
      muted: () => playback.muted,
      volume: () => playback.volume,
      hintOpen: () => pauseHintOpen.value,
      toggle: () => handleLocalMute(),
      mute: (flag) => toggleLocalMute(flag),
      volumeSet: (value) => handleVolume(value)
    },
    /** 托盘桥状态（无 preload 时 available=false）。 */
    tray: {
      available: () => Boolean(window.mpDesktop?.tray),
      state: () => ({ ...traySnapshot.value }),
      push: (patch) => pushTrayState(patch),
      /** 模拟托盘发来的命令（eval 测试用，不会真的来自主进程）。 */
      command: (type) => handleTrayCommand({ type })
    },
    /** 关闭询问弹窗（dev/eval 模拟主进程 close-request，不真正关闭窗口）。 */
    closePrompt: {
      open: () => closePromptOpen.value,
      request: (canTray = true, id = 'eval') => onCloseRequest({ id, canTray }),
      respond: (action) => respondClose(action)
    },
    /**
     * 协议 v2 只读探针（Electron 回归测试用）：会话 base / capabilities / 公开身份 /
     * 当前歌曲的 trial 与实际可播时长。**不暴露 recoveryKey 等秘密**。
     */
    protocol: {
      sessionBase: () => live.sessionBase || '',
      capabilities: () => [...(live.capabilities || [])],
      adminConfigured: () => live.adminConfigured,
      identity: () => {
        const identity = live.identity
        if (!identity) return null
        return { id: identity.id, name: identity.name, isGuest: identity.isGuest }
      },
      nowPlaying: () => {
        const song = live.nowPlaying
        if (!song) return null
        return {
          id: song.id,
          source: song.source,
          duration: song.duration,
          playableDuration: song.playableDuration,
          fullDuration: song.fullDuration,
          trial: Boolean(song.trial),
          urlType: song.urlType || null
        }
      },
      lyrics: () => ({ count: live.lyrics.length, first: live.lyrics[0]?.text || '' })
    }
  }
  // 兼容不同测试钩子命名：保留 __mp，同时暴露 __MP_DEBUG__（同一对象，增量扩展）。
  window.__MP_DEBUG__ = window.__mp
}
</script>

<template>
  <!-- 托盘状态卡窗口（?tray=1）：只渲染 TrayCard，不加载完整应用壳。 -->
  <TrayCard v-if="isTrayWindow" />
  <div
    v-else
    class="mp-app"
    :class="{
      'inspector-collapsed': !inspectorOpen,
      'is-onboarding': showOnboarding,
      'is-demo-mode': demoShell,
      'hide-console-nav': consoleLocked,
      'hide-history-nav': liveMode
    }"
  >
    <RoomLikeEffect />
    <WindowFrame
      :room="demo.room"
      @settings="settingsOpen = true"
      @search="onTitlebarSearch"
      @connect="openJoinDialog()"
      @admin="openAdminPanel"
      @help="helpOpen = true"
    />
    <UserHelp v-if="helpOpen" @close="helpOpen = false" @tour="helpOpen = false; startTutorial(0)" />
    <Teleport to="body"><div v-if="spaceHolding" class="space-hold-overlay" role="status" aria-live="polite"><div class="space-hold-indicator"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="space-hold-track"/><circle cx="50" cy="50" r="44" class="space-hold-progress" :class="{ filling: spaceProgress }" pathLength="100"/></svg><strong>{{ playback.playing ? '保持按住1s暂停' : '长按1s取消暂停' }}</strong></div></div></Teleport>

    <div class="mp-body">
      <SettingsView
        v-if="settingsOpen"
        @close="settingsOpen = false"
        @saved="pushToast('设置已保存')"
        @notify="(message) => pushToast(message)"
        @open-admin="openAdminPanel"
        @server-change="handleServerChange"
        @local-data-cleared="handleLocalDataCleared"
        @clear-data="requestClearLocalData"
        @leave-room="requestOnboarding"
      />

      <OnboardingView
        v-else-if="showOnboarding"
        :defaults="{
          serverUrl: savedLiveSettings.serverUrl,
          name: joinForm.name,
          mineServer: myRoomServer
        }"
        :joining="joining"
        :error="joinError"
        :initial-advanced="onboardingAdvanced"
        @connect="handleJoinRequest"
        @demo="enterDemoMode"
        @settings="settingsOpen = true"
        @clear-data="requestClearLocalData"
      />

      <template v-else>
      <NavRail ref="navRail" :name="live.identity?.name || joinForm.name || '游客'" :model-value="active" @update:model-value="onNavSelect" @account="openAccountMenu" />
      <AppSidebar
        :room="roomView"
        :groups="sidebar.groups"
        :create="sidebar.create"
        @select="handleSidebarSelect"
      />

      <main class="mp-main">
        <CommandBar
          v-bind="command"
          :inspector-open="inspectorOpen"
          @segment="handleSegment"
          @primary="handleCommandPrimary"
          @toggle-inspector="toggleInspector"
        />

        <Transition name="banner">
          <div v-if="showReconnect" class="reconnect-bar">
            <span class="reconnect-spinner"></span>
            <span class="reconnect-text">
              {{ liveMode ? '与服务器的连接已断开，正在自动重连…' : '与服务器的连接已断开，正在尝试重连…' }}
            </span>
            <button class="text-btn" @click="liveMode ? doJoin() : goOnline()">
              {{ liveMode ? '立即重连' : '立即重连' }}
            </button>
          </div>
        </Transition>

        <div v-if="!liveMode" class="demo-banner">
          <span class="demo-banner-dot"></span>
          <span class="demo-banner-text">演示数据 · 开放授权音乐</span>
          <button class="text-btn" @click="openJoinDialog()">连接房间 →</button>
          <button class="text-btn demo-banner-return" @click="requestOnboarding()">返回加入界面</button>
        </div>

        <div class="mp-workspace-row">
          <Transition name="view" mode="out-in">
            <PartyView
              v-if="active === 'party'"
              key="party"
              :now-playing="nowPlayingView"
              :queue="queueView"
              :lyrics="lyricsView"
              :live="liveMode"
              :play-mode="live.compactSync ? (live.playMode || '') : ''"
              :playback-id="live.playbackId || ''"
              :can-seek="liveMode && live.compactSync && live.config.allowSeek && !live.loading && !!live.playbackId && !live.identity?.isGuest"
              :mode-locked="live.playModeLocked || !!live.identity?.isGuest"
              :pause-hint="pauseHintOpen"
              :desktop-lyrics-open="desktopLyricsOpen"
              :desktop-lyrics-available="!!desktopLyrics"
              @refresh-list="refreshList"
              @toggle-desktop-lyrics="desktopLyrics?.toggle()"
              @skip="handleSkip"
              @search="active = 'search'"
              @volume="handleVolume"
              @local-mute="handleLocalMute"
              @like="handleTrayCommand({type:'like'})"
              @show-queue="openFullQueue()"
              @global-toggle="handleTogglePlay"
              @play-mode="handleRoomMode"
              @seek-room="handleRoomSeek"
              @dismiss-pause-hint="dismissLocalMuteHint"
            />
            <LikedSongsView v-else-if="active === 'queue' && showLikedSongs" key="liked-songs" @add="addToQueue" @select="(song) => { searchSelected = song; inspectorOpen = true }" @error="(message) => pushToast(message, 'warn')" />
            <QueueView
              v-else-if="active === 'queue'"
              key="queue"
              :queue="filteredQueueView"
              :selected-id="selectedId"
              :live="liveMode"
              :show-refresh="liveMode && !nowPlayingView && queueFilter === 'all' && queueSource === 'all'"
              @refresh-list="refreshList"
              :allow-reorder="live.compactSync && queueFilter === 'all' && queueSource === 'all'"
              @select="(id) => (selectedId = id)"
              @reorder="handleReorder"
              @action="handleQueueAction"
            />
            <SearchView
              v-else-if="active === 'search'"
              key="search"
              :selected-id="searchSelected?.id || ''"
              :live-mode="liveMode"
              @select="(song) => (searchSelected = song)"
              @add="addToQueue"
            />
            <ChatView
              v-else-if="active === 'chat'"
              key="chat"
              :messages="filteredChatMessages"
              :live="liveMode"
              @send="handleChatSend"
              @add="addToQueue"
              @find="findHistorySong"
            />
            <HistoryView
              v-else-if="active === 'history'"
              key="history"
              :selected-id="historySelected?.id || ''"
              :live-mode="liveMode"
              @select="(song) => (historySelected = song)"
              @add="addToQueue"
            />
            <!-- 演示模式：控制台 = 只读演示预览（本地服务真实态）；真实管理在 AdminView。 -->
            <ConsoleView
              v-else-if="active === 'console' && !liveMode"
              key="console-demo"
              @open-admin="openAdminPanel"
              @open-settings="settingsOpen = true"
            />
            <!-- 真实房间：控制台入口只有管理员认证后可达（onNavSelect 直接打开 AdminView）。 -->
            <div v-else-if="active === 'console'" id="console-live" key="console-live" class="workspace console-lock">
              <div class="console-lock-panel">
                <div class="console-lock-icon"><Lock :size="20" :stroke-width="1.8" /></div>
                <span class="label">管理终端 · ADMIN</span>
                <h2 class="console-lock-title">真实管理能力在管理终端</h2>
                <p class="console-lock-text">
                  实时房间不再展示演示控制台。房间密码、锁定、播放控制、音源 Cookie、直播流开关与系统参数
                  都在真实管理终端中操作，需要先通过服务端管理员密码认证。
                </p>
                <ul class="console-lock-list">
                  <li>普通成员仍可：搜索点歌、查看队列、聊天、查看连接状态</li>
                  <li>管理员会话只保存在本次运行的内存中，关闭应用后需要重新认证</li>
                </ul>
                <div class="console-lock-actions">
                  <button class="btn-primary" @click="active = 'party'">返回派对</button>
                  <button class="btn-ghost" @click="openAdminPanel()">
                    {{ adminAuthed ? '打开管理终端' : '管理员认证' }}
                  </button>
                </div>
              </div>
            </div>
            <StatesView v-else-if="active === 'states'" key="states" />
            <div v-else :key="active" class="workspace">
              <div class="workspace-inner">
                <div class="empty-state">
                  <div class="empty-mark">{{ active.slice(0, 1).toUpperCase() }}</div>
                  <div class="empty-title">该模块将在后续节点完成</div>
                  <div class="empty-text">
                    当前已完成「派对」与「队列」两个主界面：设计系统、窗口框架、导航、侧栏、
                    命令栏、工作区表格、检查器与动效基线。搜索、聊天、历史、控制台与设置会在后续节点实现。
                  </div>
                  <button class="btn-primary">返回派对</button>
                </div>
              </div>
            </div>
          </Transition>

          <Transition name="insp" mode="out-in">
            <TrackInspector
              v-if="inspectorOpen && active === 'queue' && showLikedSongs && searchSelected"
              key="liked-track"
              :song="searchSelected"
              mode="search"
              @close="searchSelected = null"
              @action="handleSearchAction"
            />
            <TrackInspector
              v-else-if="inspectorOpen && active === 'search' && searchSelected"
              key="search"
              :song="searchSelected"
              mode="search"
              @close="searchSelected = null"
              @action="handleSearchAction"
            />
            <TrackInspector
              v-else-if="inspectorOpen && active === 'history' && !liveMode && historySelected"
              key="history"
              :song="historySelected"
              mode="history"
              @close="historySelected = null"
              @action="handleHistoryAction"
            />
            <TrackInspector
              v-else-if="inspectorOpen && active === 'queue' && !showLikedSongs && selectedSong"
              key="track"
              :song="selectedSong"
              @close="selectedId = ''"
              @action="handleInspectorAction"
            />
            <RoomInspector
              v-else-if="inspectorOpen"
              key="room"
              :room="roomView"
              :members="membersView"
              :activity="activityView"
              :messages="instantChatMessages"
              :send-message="handleChatSend"
              :section="roomInspectorSection"
              @add="addToQueue"
              @find="findHistorySong"
              @section="(value) => { roomInspectorSection = value; if (value === 'activity') unreadChat = 0 }"
              @action="handleRoomInspectorAction"
              @close="inspectorOpen = false"
            />
          </Transition>
        </div>
      </main>
      </template>
    </div>

    <StatusBar v-if="!showOnboarding" :room="roomView" :live="live" :demo="demoShell" />
    <footer v-else-if="!settingsOpen" class="onboarding-status">
      <span class="dot"></span>
      <span>未加入房间 · 尚未连接任何服务器</span>
      <span style="opacity: 0.5">|</span>
      <span>「我的房间」需要本地服务；「加入房间」需要朋友给出的服务器地址</span>
      <span class="status-spacer"></span>
      <span class="status-hint"><span class="status-kbd">CTRL ,</span>设置</span>
    </footer>

    <ContextMenu
      v-if="accountMenu"
      :x="accountMenu.x"
      :y="accountMenu.y"
      :items="accountItems"
      @select="handleAccountSelect"
      @close="accountMenu = null"
    />

    <JoinDialog
      v-if="!showOnboarding"
      :open="joinOpen"
      :joining="joining"
      :error="joinError"
      :defaults="{ serverUrl: joinForm.serverUrl, name: joinForm.name }"
      :mine-server="myRoomServer"
      @connect="handleJoinRequest"
      @close="joinOpen = false"
    />

    <TutorialOverlay
      :active="tutorialActive"
      :start-step="tutorialStartStep"
      :admin-available="tutorialAdminAvailable"
      @change="(step) => (tutorialStepNow = step)"
      @finish="finishTutorial"
      @open-appearance="settingsOpen = true"
    />

    <AdminAuthDialog
      :open="adminAuthOpen"
      @verified="adminAuthOpen = false; adminOpen = true"
      @close="adminAuthOpen = false"
      @open-settings="adminAuthOpen = false; settingsOpen = true"
    />
    <AdminView
      v-if="adminOpen && adminAuth.verified"
      @close="adminOpen = false"
      @open-settings="adminOpen = false; settingsOpen = true"
    />

    <NicknameDialog
      :open="nicknameOpen"
      :busy="nicknameBusy"
      :error="nicknameError"
      :initial="live.identity?.name && live.identity.name !== '游客' ? live.identity.name : ''"
      @submit="submitNickname"
      @close="nicknameOpen = false"
    />

    <Toasts />
    <CommandPalette
      :open="paletteOpen"
      :items="paletteItems"
      :live="liveMode"
      :initial-query="paletteInitialQuery"
      @close="paletteOpen = false"
      @select="paletteSelect"
      @add="addToQueue"
    />
    <ConfirmDialog
      :open="!!confirmState"
      :title="confirmState?.title || ''"
      :text="confirmState?.text || ''"
      :confirm-label="confirmState?.confirmLabel || '确认'"
      :danger="!!confirmState?.danger"
      @confirm="runConfirm"
      @cancel="confirmState = null"
    />

    <div v-if="clearingLocalData" role="alertdialog" aria-modal="true" style="position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:grid;place-items:center;color:white;font-size:18px">正在清除本地数据，请稍候…</div>

    <!-- 关闭询问（launcher-ipc 渲染层契约：onCloseRequest → respondClose）
         默认焦点「隐藏到托盘」；Esc = 取消；canTray=false 时不展示隐藏选项。
         自动化（MP_SHOT / MP_EVAL）下主进程不拦截真实关闭，仅 MP_CLOSE_PROMPT=1 派发模拟请求。 -->
    <div
      v-if="closePromptOpen"
      class="close-dialog-backdrop"
      @mousedown.self="respondClose('cancel')"
    >
      <div class="close-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
        <span class="label">关闭 · CLOSE</span>
        <h3 id="close-dialog-title" class="close-dialog-title">要关闭 Music Party 吗？</h3>
        <p class="close-dialog-text">
          隐藏到托盘后音乐继续播放，可随时从托盘打开主界面；关闭应用会停止本机播放并断开房间
          （房间里的其他成员不受影响）。
        </p>
        <label class="close-remember"><input v-model="rememberClose" type="checkbox" /> 记住我的选择（可在设置中更改）</label>
        <div class="close-dialog-actions">
          <button
            ref="closeDefaultButton"
            class="btn-primary"
            type="button"
            @click="respondClose(closePrompt.canTray === false ? 'close' : 'tray')"
          >
            {{ closePrompt.canTray === false ? '关闭应用' : '隐藏到托盘' }}
          </button>
          <button
            v-if="closePrompt.canTray !== false"
            class="btn-ghost"
            type="button"
            @click="respondClose('close')"
          >
            关闭应用
          </button>
          <button class="btn-ghost" type="button" @click="respondClose('cancel')">取消</button>
        </div>
        <p class="close-dialog-hint">Esc 取消 · 默认操作：隐藏到托盘（Esc 键继续留在应用）</p>
      </div>
    </div>
  </div>
</template>

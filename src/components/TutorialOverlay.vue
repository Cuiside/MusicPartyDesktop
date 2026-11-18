<script>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** localStorage key: the interface tour only auto-starts once. */
export const TUTORIAL_KEY = 'mp.desktop.tutorial.v1'

/**
 * Desktop-app specific interface tour. Targets are resolved against the real DOM
 * with `querySelector`; steps whose target is missing / invisible (e.g. the admin
 * console for a non-admin listener, or the player for an empty room) are skipped
 * automatically so the tour can never get stuck.
 */
const STEPS = [
  {
    id: 'account',
    title: '这是你的账号',
    text: '左下角是账号入口，默认昵称「游客」，加入房间后会出现在成员列表里。之后也可以从这里重新连接房间或打开设置。',
    targets: ['.nav-account']
  },
  {
    id: 'search',
    title: '搜索并点歌',
    text: '点左侧「搜索」，或随时按 CTRL K 打开命令面板。选中歌曲后点「点歌」，它会加入全房间的播放队列。',
    targets: ['.nav-item[title="搜索"]', '.titlebar-search']
  },
  {
    id: 'queue',
    title: '播放队列',
    text: '「队列」里是接下来要播放的歌：可以置顶或移除，操作会实时同步给房间里的所有人。支持的房间可按规则拖拽排序，具体权限由房间决定。',
    targets: ['.nav-item[title="队列"]']
  },
  {
    id: 'transport',
    title: '播放控制',
    text: '单击播放键只切换本机静音；长按播放键可暂停或恢复房间，切歌影响全房间。右侧音量只影响本机。',
    targets: ['.transport', '.transport-play']
  },
  {
    id: 'like',
    title: '给当前歌曲点赞',
    text: '点击当前歌曲封面或 ♥ 可以点赞，热度会同步给房间里的所有人。',
    targets: ['.hero-chips .chip:nth-child(2)', '.hero-chips .chip', '.hero']
  },
  {
    id: 'chat',
    title: '聊天与命令',
    text: '在「聊天」里和其他听众交流：输入 //stream 获取直播流链接（私聊收到），输入 //clear 清空自己点的歌。',
    targets: ['.nav-item[title="聊天"]']
  },
  {
    id: 'connection',
    title: '连接状态与设置',
    text: '右上角显示连接状态与延迟，断线会自动重连。需要启动本地服务或调整音源，点旁边的齿轮打开设置。',
    targets: ['.conn', '.titlebar-right']
  },
  {
    id: 'appearance',
    title: '主题与明暗模式',
    text: '右上角可切换明暗模式；点击齿轮进入设置，在播放页的主题颜色中选择黄、粉、蓝、红或紫。',
    targets: ['.mode-switch']
  },
  {
    id: 'admin',
    title: '管理员配置',
    text: '管理员可通过顶部盾牌登录，在控制台管理音源、凭据和房间参数。',
    targets: ['[data-tutorial="admin"]', '.nav-item[title="控制台"]'],
    adminOnly: true
  }
]
</script>

<script setup>
const props = defineProps({
  active: { type: Boolean, default: false },
  startStep: { type: Number, default: 0 },
  adminAvailable: { type: Boolean, default: false }
})
const emit = defineEmits(['finish', 'change', 'open-appearance'])

const index = ref(0)
const spot = ref(null)
const cardStyle = ref(null)
const cardEl = ref(null)
const hasNext = ref(true)

const current = computed(() => STEPS[index.value] || STEPS[0])
const labelText = computed(() => `界面引导 · ${index.value + 1} / ${STEPS.length}`)

const stepAllowed = (step) => !step.adminOnly || props.adminAvailable

const isVisible = (el) => {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = window.getComputedStyle(el)
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity || 1) > 0.05 &&
    el.getClientRects().length > 0
  )
}

const findTarget = (step) => {
  for (const selector of step?.targets || []) {
    let el = null
    try {
      el = document.querySelector(selector)
    } catch {
      el = null
    }
    if (isVisible(el)) return el
  }
  return null
}

const scanNext = () => {
  for (let i = index.value + 1; i < STEPS.length; i += 1) {
    const step = STEPS[i]
    if (!stepAllowed(step)) continue
    if (findTarget(step)) return true
  }
  return false
}

const finish = (reason = 'done') => {
  try {
    localStorage.setItem(TUTORIAL_KEY, '1')
  } catch {
    /* private mode / quota: the tour may appear again next launch */
  }
  emit('finish', reason)
}

const place = async (el) => {
  if (!el) return false
  const box = el.getBoundingClientRect()
  const pad = 6
  const rect = {
    top: Math.max(2, box.top - pad),
    left: Math.max(2, box.left - pad),
    width: Math.min(window.innerWidth - 4, box.width + pad * 2),
    height: box.height + pad * 2
  }
  spot.value = rect

  const width = Math.min(380, window.innerWidth - 32)
  cardStyle.value = { width: `${width}px` }
  await nextTick()

  const height = cardEl.value ? cardEl.value.offsetHeight : 230
  const gap = 16
  const margin = 16
  const spaceBelow = window.innerHeight - (rect.top + rect.height)
  const spaceAbove = rect.top
  let top
  if (spaceBelow >= height + gap + margin || spaceBelow >= spaceAbove) {
    top = rect.top + rect.height + gap
  } else {
    top = rect.top - gap - height
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin))
  const left = Math.max(
    margin,
    Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - margin)
  )
  cardStyle.value = { width: `${width}px`, left: `${left}px`, top: `${top}px` }
  hasNext.value = scanNext()
  emit('change', index.value)
  return true
}

const resolve = async (from, direction) => {
  let i = from
  while (i >= 0 && i < STEPS.length) {
    const step = STEPS[i]
    if (stepAllowed(step)) {
      const el = findTarget(step)
      if (el) {
        index.value = i
        await place(el)
        return true
      }
    }
    i += direction
  }
  return false
}

const begin = async () => {
  const start = Math.max(0, Math.min(Number(props.startStep) || 0, STEPS.length - 1))
  const found = await resolve(start, 1)
  if (!found) finish('unavailable')
}

const next = async () => {
  const found = await resolve(index.value + 1, 1)
  if (!found) finish()
}
const openAppearance = () => { finish('appearance'); emit('open-appearance') }

const prev = async () => {
  const found = await resolve(index.value - 1, -1)
  if (!found && current.value) {
    const el = findTarget(current.value)
    if (el) await place(el)
  }
}

const skip = () => finish('skip')

const refresh = async () => {
  if (!props.active || !current.value) return
  const el = findTarget(current.value)
  if (el) {
    await place(el)
    return
  }
  // The current target vanished (view change / room state): advance and skip it.
  const found = await resolve(index.value + 1, 1)
  if (!found) finish('unavailable')
}

const onKey = (event) => {
  if (!props.active) return
  if (event.key === 'Escape') {
    event.preventDefault()
    skip()
    return
  }
  if (event.key === 'ArrowRight' || event.key === 'Enter') {
    // Let the card buttons handle their own Enter/Space activation.
    const target = event.target
    if (target instanceof HTMLElement && target.closest('.tutorial-card')) return
    event.preventDefault()
    void next()
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    void prev()
  }
}

watch(
  () => props.active,
  (open) => {
    if (open) {
      void begin()
    } else {
      spot.value = null
      cardStyle.value = null
    }
  }
)

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', refresh)
  window.addEventListener('scroll', refresh, true)
  if (props.active) void begin()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', refresh)
  window.removeEventListener('scroll', refresh, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="active"
      id="tutorial"
      class="tutorial"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorial-title"
    >
      <div class="tutorial-dim" aria-hidden="true"></div>

      <div
        v-if="spot"
        class="tutorial-spot"
        aria-hidden="true"
        :style="{
          top: `${spot.top}px`,
          left: `${spot.left}px`,
          width: `${spot.width}px`,
          height: `${spot.height}px`
        }"
      >
        <i class="tutorial-corner tl"></i>
        <i class="tutorial-corner tr"></i>
        <i class="tutorial-corner bl"></i>
        <i class="tutorial-corner br"></i>
      </div>

      <div ref="cardEl" class="tutorial-card" :style="cardStyle || {}">
        <div class="tutorial-head">
          <span class="label">{{ labelText }}</span>
          <button type="button" class="text-btn" @click="skip">跳过</button>
        </div>
        <div id="tutorial-title" class="tutorial-title">{{ current.title }}</div>
        <p class="tutorial-text">{{ current.text }}</p>
        <button v-if="current.id === 'appearance'" class="btn-primary" type="button" @click="openAppearance">打开设置中的主题颜色</button>
        <div class="tutorial-progress" aria-hidden="true">
          <span
            v-for="(step, i) in STEPS"
            :key="step.id"
            class="tutorial-pip"
            :class="{ on: i === index, done: i < index, muted: !stepAllowed(step) }"
          ></span>
        </div>
        <div class="tutorial-actions">
          <button type="button" class="text-btn" :disabled="index === 0" @click="prev">
            上一步
          </button>
          <div class="tutorial-actions-right">
            <span class="tutorial-hint">← → 切换 · ESC 跳过</span>
            <button type="button" class="btn-primary" @click="next">
              {{ hasNext ? '下一步' : '开始使用' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

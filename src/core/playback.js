import { reactive } from 'vue'

/**
 * 本机媒体偏好：**只影响 APP 内音频引擎**，与系统音量、房间（服务器）音量完全解耦。
 *
 * - `volume`：0..100，首次读取 localStorage，缺省 60%（服务端没有音量字段）；
 * - `muted`：本机静音，不持久化，避免下次启动意外无声；
 * - 变更通过 App.vue 的 watcher 单向下发给 `core/audio/engine.js`。
 */

/** localStorage：本机音量（0..100 的整数字符串）。 */
export const LOCAL_VOLUME_KEY = 'mp.audio.volume.v1'

/** localStorage：首次"本机静音"说明只弹一次的标记。 */
export const LOCAL_MUTE_HINT_KEY = 'mp.audio.muteHint.v1'

/** 长按播放键触发全局暂停/恢复的阈值（毫秒）。 */
export const LONG_PRESS_MS = 500

/** 服务端没有音量字段时的本机默认音量（0..100）。 */
export const DEFAULT_VOLUME = 60

/**
 * 把任意输入夹取成合法的 0..100 整数音量。
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampVolume(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_VOLUME
  return Math.min(100, Math.max(0, Math.round(numeric)))
}

/**
 * 读取持久化的本机音量；localStorage 不可用或内容损坏时回退默认值。
 *
 * @returns {number} 0..100。
 */
function readStoredVolume() {
  try {
    const raw = localStorage.getItem(LOCAL_VOLUME_KEY)
    return raw == null ? DEFAULT_VOLUME : clampVolume(raw)
  } catch {
    return DEFAULT_VOLUME
  }
}

// Shared playback state. In node-08 the real AudioEngine drives this;
// for now it powers the party screen and the global space shortcut.
export const playback = reactive({
  playing: true,
  progress: 0,
  duration: 8,
  /** 本机媒体音量 0..100（持久化；只影响 APP，不修改系统/房间音量）。 */
  volume: readStoredVolume(),
  /** 本机静音（不持久化；只影响 APP）。 */
  muted: false
})

/**
 * 设置本机音量（0..100，自动夹取并写入 localStorage）。
 *
 * @param {unknown} value
 * @returns {number} 实际生效音量。
 */
export function setLocalVolume(value) {
  const next = clampVolume(value)
  playback.volume = next
  try {
    localStorage.setItem(LOCAL_VOLUME_KEY, String(next))
  } catch {
    /* 隐私模式 / 配额：内存态仍生效 */
  }
  return next
}

/**
 * 切换/设置本机静音。
 *
 * @param {boolean} [flag] 不传时切换。
 * @returns {boolean} 设置后的静音状态。
 */
export function toggleLocalMute(flag) {
  playback.muted = flag === undefined ? !playback.muted : Boolean(flag)
  return playback.muted
}

/**
 * 是否已经看过"单击=本机静音 / 长按=全局暂停"的一次性说明。
 *
 * @returns {boolean}
 */
export function hasSeenLocalMuteHint() {
  try {
    return localStorage.getItem(LOCAL_MUTE_HINT_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 记录一次性说明已展示（下次启动不再弹）。
 *
 * @returns {void}
 */
export function markLocalMuteHintSeen() {
  try {
    localStorage.setItem(LOCAL_MUTE_HINT_KEY, '1')
  } catch {
    /* 隐私模式：本次会话内仍只弹一次 */
  }
}

/** 演示模式（无房间连接）的本地播放进度开关，与真实房间播放态无关。 */
export function togglePlay() {
  playback.playing = !playback.playing
}

export function tickPlayback(delta = 1) {
  if (!playback.playing) return
  playback.progress = playback.progress + delta >= playback.duration ? 0 : playback.progress + delta
}

/**
 * 可复用的频谱条绘制辅助（框架无关）。
 *
 * 视觉与 `src/components/Visualizer.vue` 保持一致：黑色竖条、3px 间隙、
 * 低频高/高频低的包络、每第 9 根一根淡化"节拍"条。区别是数据源从
 * `<audio>` 的合成波形换成 {@link module:core/audio/engine} 的 AnalyserNode
 * bins；分析器不可用时退回同样的合成波形，保证界面观感不塌。
 *
 * 用法（Vue 组件里 onMounted/onBeforeUnmount 成对调用）：
 * ```js
 * import { createBarsVisualizer } from '@/core/audio/visualizer'
 * let viz = null
 * onMounted(() => { viz = createBarsVisualizer(canvasEl, { engine }) })
 * onBeforeUnmount(() => viz?.destroy())
 * ```
 *
 * @module core/audio/visualizer
 */

/** 默认视觉参数（与现有 Visualizer.vue 对齐）。 */
export const DEFAULT_STYLE = {
  bars: 64,
  gap: 3,
  minBar: 2,
  color: 'rgba(20,19,20,0.82)',
  accentColor: 'rgba(20,19,20,0.45)',
  accentEvery: 9,
  smoothing: 0.14,
  idleHeight: 0.08
}

/** 无 analysebins 时的合成波形振幅（同原组件）。 */
const SYNTH_ACTIVE_SPEED = 1.7
const SYNTH_ACTIVE_SECONDARY = 0.63

/**
 * 与原组件一致的"低频高、高频低"包络。
 *
 * @param {number} index 第几根 bar。
 * @param {number} total bar 总数。
 * @returns {number} 0..1 的包络系数。
 */
export function barEnvelope(index, total) {
  if (!(total > 1)) return 1
  const x = index / (total - 1)
  const tilt = Math.pow(1 - x, 0.85) * 0.62 + 0.16
  const bump =
    0.2 * Math.exp(-Math.pow((x - 0.22) / 0.09, 2)) +
    0.14 * Math.exp(-Math.pow((x - 0.58) / 0.12, 2))
  return Math.min(1, tilt + bump)
}

/**
 * 把 `engine.getFrequencyBins()` 的字节值映射成 0..1 的条高，
 * 并叠加包络避免高频噪声顶满画布。
 *
 * @param {Uint8Array} bins 频域数据。
 * @param {number} index
 * @param {number} total
 * @returns {number} 0..1。
 */
function binsToHeight(bins, index, total) {
  const raw = total > 0 ? (bins[Math.min(bins.length - 1, index)] || 0) / 255 : 0
  const shaped = Math.pow(raw, 0.9)
  const envelope = barEnvelope(index, total)
  return Math.max(0.02, Math.min(1, shaped * (0.45 + 0.55 * envelope) + 0.02))
}

/**
 * 合成波形高度（分析器不可用或暂停时的兜底，公式取自 Visualizer.vue）。
 *
 * @param {number} index
 * @param {number} total
 * @param {number} time 秒。
 * @param {boolean} active 是否处于播放态。
 * @returns {number} 0..1。
 */
function synthHeight(index, total, time, active) {
  const envelope = barEnvelope(index, total)
  if (!active) return Math.max(0.04, envelope * 0.2)
  const wave =
    0.55 +
    0.45 *
      Math.sin(time * SYNTH_ACTIVE_SPEED + index * 0.42) *
      Math.sin(time * SYNTH_ACTIVE_SECONDARY + index * 0.11)
  return Math.max(0.04, envelope * (0.35 + 0.75 * wave))
}

/**
 * 折线光谱条渲染器。
 */
export class BarsVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas 目标 canvas。
   * @param {Object} [options]
   * @param {{ hasAnalyser?: boolean, playing?: boolean, getFrequencyBins?: (count: number) => Uint8Array }} [options.engine]
   *   音频引擎单例（传 `engine` 即可；不传则只画合成波形）。
   * @param {number} [options.bars] 条数，默认 64。
   * @param {number} [options.gap] 条间距（px），默认 3。
   * @param {boolean} [options.reducedMotion] 是否使用静态帧；默认跟随
   *   `prefers-reduced-motion: reduce`。
   */
  constructor(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('BarsVisualizer: 需要有效的 <canvas> 元素')
    }
    /** @type {HTMLCanvasElement} */
    this.canvas = canvas
    /** @type {{ hasAnalyser?: boolean, playing?: boolean, getFrequencyBins?: Function } | null} */
    this.engine = options.engine || null
    this.style = { ...DEFAULT_STYLE, ...options.style }
    if (Number.isFinite(Number(options.bars))) this.style.bars = Math.max(2, Math.round(Number(options.bars)))
    if (Number.isFinite(Number(options.gap))) this.style.gap = Math.max(0, Number(options.gap))

    const prefersReduced =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
    this.reducedMotion =
      options.reducedMotion === undefined ? prefersReduced : Boolean(options.reducedMotion)

    /** @type {CanvasRenderingContext2D | null} */
    this.ctx = null
    this.width = 0
    this.height = 0
    this.dpr = 1
    /** @type {number[]} 平滑后的条高。 */
    this.values = new Array(this.style.bars).fill(this.style.idleHeight)
    this.time = 0
    this.raf = 0
    this.started = false
    /** @type {ResizeObserver | null} */
    this.resizeObserver = null
    /** @type {((event: MediaQueryListEvent) => void) | null} */
    this.reducedListener = null
    /** @type {MediaQueryList | null} */
    this.reducedQuery = null
    this.resize = this.resize.bind(this)
    this.frame = this.frame.bind(this)
  }

  /**
   * 替换数据源引擎。
   *
   * @param {Object | null} engine
   * @returns {void}
   */
  setEngine(engine) {
    this.engine = engine || null
  }

  /**
   * 绑定 canvas 尺寸（含 devicePixelRatio），并监听容器尺寸变化。
   *
   * @returns {void}
   */
  resize() {
    const canvas = this.canvas
    if (!canvas) return
    const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    this.dpr = dpr
    this.width = Math.max(1, rect ? rect.width : canvas.clientWidth || canvas.width || 1)
    this.height = Math.max(1, rect ? rect.height : canvas.clientHeight || canvas.height || 1)
    canvas.width = Math.round(this.width * dpr)
    canvas.height = Math.round(this.height * dpr)
    this.ctx = canvas.getContext('2d')
    if (this.ctx) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!this.started || this.reducedMotion) this.drawOnce()
  }

  /**
   * 开始渲染循环（已开始时幂等）。
   *
   * @returns {void}
   */
  start() {
    if (this.started) return
    this.started = true
    if (typeof ResizeObserver !== 'undefined' && !this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(this.resize)
      this.resizeObserver.observe(this.canvas)
    }
    this.watchReducedMotion()
    if (this.reducedMotion) {
      this.drawOnce()
      return
    }
    this.raf = requestAnimationFrame(this.frame)
  }

  /**
   * 暂停渲染循环（保留状态，可再 start）。
   *
   * @returns {void}
   */
  stop() {
    this.started = false
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
  }

  /**
   * 跟随系统"减少动态效果"偏好：切到 reduce 时停止循环并画一帧静态图。
   *
   * @returns {void}
   */
  watchReducedMotion() {
    if (this.reducedListener || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    this.reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.reducedListener = (event) => {
      this.reducedMotion = Boolean(event.matches)
      if (this.reducedMotion) {
        if (this.raf) {
          cancelAnimationFrame(this.raf)
          this.raf = 0
        }
        this.drawOnce()
      } else if (this.started) {
        this.raf = requestAnimationFrame(this.frame)
      }
    }
    if (typeof this.reducedQuery.addEventListener === 'function') {
      this.reducedQuery.addEventListener('change', this.reducedListener)
    }
  }

  /**
   * 取当前应显示的 0..1 条高目标值（读取 engine bins / 合成波形兜底）。
   *
   * @param {number} time 秒。
   * @returns {number[]} 与 `style.bars` 等长的目标值。
   */
  targets(time) {
    const count = this.style.bars
    const source = this.engine
    const playing = Boolean(source && source.playing)
    const analyserReady = Boolean(
      source && source.hasAnalyser && typeof source.getFrequencyBins === 'function'
    )

    if (analyserReady) {
      const bins = source.getFrequencyBins(count)
      const heights = new Array(count)
      for (let i = 0; i < count; i++) heights[i] = binsToHeight(bins, i, count)
      return heights
    }

    // 没有真实频谱：沿用原组件的合成波形（暂停时是低矮静态条）
    const heights = new Array(count)
    for (let i = 0; i < count; i++) heights[i] = synthHeight(i, count, time, playing)
    return heights
  }

  /**
   * 渲染一帧（内部 rAF 回调；也可手动调用做静态帧）。
   *
   * @param {number} [now] `performance.now()` 时间戳。
   * @returns {void}
   */
  frame(now) {
    if (!this.started || this.reducedMotion) return
    const time = (Number(now) || 0) / 1000
    this.time = time
    this.render(time)
    this.raf = requestAnimationFrame(this.frame)
  }

  /**
   * 单帧绘制入口（供静态帧/外部手动驱动复用）。
   *
   * @param {number} [time] 秒。
   * @returns {void}
   */
  render(time) {
    const ctx = this.ctx
    const canvas = this.canvas
    if (!ctx || !canvas) return
    const width = this.width || canvas.clientWidth
    const height = this.height || canvas.clientHeight
    const count = this.style.bars
    const targets = this.targets(typeof time === 'number' ? time : this.time)

    ctx.clearRect(0, 0, width, height)
    const gap = this.style.gap
    const barWidth = Math.max(2, (width - gap * (count - 1)) / count)

    for (let i = 0; i < count; i++) {
      const target = targets[Math.min(targets.length - 1, i)]
      if (this.reducedMotion) {
        // 静态帧：直接采用目标值，不做逐帧平滑
        this.values[i] = target
      } else {
        this.values[i] += (target - this.values[i]) * this.style.smoothing
      }
      const barHeight = Math.max(this.style.minBar, this.values[i] * (height - 2))
      const x = i * (barWidth + gap)
      ctx.fillStyle = this.style.accentEvery > 0 && i % this.style.accentEvery === 4
        ? this.style.accentColor
        : this.style.color
      ctx.fillRect(x, height - barHeight, barWidth, barHeight)
    }
  }

  /**
   * 立即绘制一帧静态图（reduced-motion 模式使用）。
   *
   * @param {number} [time] 秒。
   * @returns {void}
   */
  drawOnce(time) {
    if (!this.ctx) this.resize()
    if (!this.ctx) return
    this.render(typeof time === 'number' ? time : this.time)
  }

  /**
   * 调试/测试用状态快照。
   *
   * @returns {{ bars: number, width: number, height: number, reducedMotion: boolean, hasAnalyser: boolean, active: boolean }}
   */
  getStatus() {
    return {
      bars: this.style.bars,
      width: this.width,
      height: this.height,
      reducedMotion: this.reducedMotion,
      hasAnalyser: Boolean(this.engine && this.engine.hasAnalyser),
      active: Boolean(this.engine && this.engine.playing)
    }
  }

  /**
   * 挂载：尺寸绑定 + 开始循环。返回自身便于链式调用。
   *
   * @returns {BarsVisualizer}
   */
  attach() {
    this.resize()
    this.start()
    return this
  }

  /**
   * 销毁：取消 rAF、断开 ResizeObserver、移除媒体查询监听。
   *
   * @returns {void}
   */
  destroy() {
    this.stop()
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    if (this.reducedQuery && this.reducedListener) {
      if (typeof this.reducedQuery.removeEventListener === 'function') {
        this.reducedQuery.removeEventListener('change', this.reducedListener)
      }
      this.reducedListener = null
      this.reducedQuery = null
    }
    this.ctx = null
  }
}

/**
 * 工厂函数：创建并挂载频谱条渲染器（一行接入）。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} [options] 同 {@link BarsVisualizer} 构造函数。
 * @returns {BarsVisualizer}
 */
export function createBarsVisualizer(canvas, options = {}) {
  return new BarsVisualizer(canvas, options).attach()
}

export default createBarsVisualizer

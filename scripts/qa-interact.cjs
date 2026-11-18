'use strict'
// QA interaction harness: evaluates JS inside the built Electron renderer through the
// MP_EVAL_FILE hook in electron/main.cjs, prints the returned JSON, and optionally
// captures a screenshot (MP_SHOT). One Electron per invocation; run tests serially.
//
// Usage:
//   node scripts/qa-interact.cjs <test> [--view <v>] [--width 1440] [--height 900]
//       [--extra palette=1] [--wait 1500] [--shot screenshots/qa/<name>.png]
//
// Tests: palette, palette-jump, space, ctrl-settings, toast, confirm, drag, focus,
//        contrast, emptiness, context-menu, metrics, banner
//
// Exit code 0 when the eval result is parsed, 1 otherwise.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const TMP_DIR = path.join(ROOT, 'screenshots', 'qa', '_eval')

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rect = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }
  }
  const text = (el) => (el ? el.textContent.trim().replace(/\\s+/g, ' ') : null)
  const key = (k, opts) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})))
  const clickText = (selector, needle) => {
    const el = [...document.querySelectorAll(selector)].find((n) => n.textContent.includes(needle))
    if (el) el.click()
    return Boolean(el)
  }
`

const TESTS = {
  /* Ctrl+K opens the palette, input filters it, Escape closes it. */
  palette: `
    (async () => {
      ${helpers}
      const out = {}
      out.openBefore = Boolean(document.querySelector('.palette'))
      key('k', { ctrlKey: true }); await sleep(200)
      out.openAfterCtrlK = Boolean(document.querySelector('.palette'))
      out.inputFocused = document.activeElement === document.querySelector('.palette-input input')
      out.itemsTotal = document.querySelectorAll('.palette-item').length
      out.allLabels = [...document.querySelectorAll('.palette-label')].map((e) => e.textContent.trim())
      const input = document.querySelector('.palette-input input')
      if (input) {
        input.value = '队列'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(200)
        out.itemsFiltered = document.querySelectorAll('.palette-item').length
        out.filteredLabels = [...document.querySelectorAll('.palette-label')].map((e) => e.textContent.trim())
      }
      key('Escape'); await sleep(450)
      out.openAfterEsc = Boolean(document.querySelector('.palette'))
      return out
    })()
  `,

  /* Palette "前往 队列" actually changes the active view + command bar title. */
  'palette-jump': `
    (async () => {
      ${helpers}
      const out = { titleBefore: text(document.querySelector('.cmd-title h1')) }
      key('k', { ctrlKey: true }); await sleep(200)
      out.clicked = clickText('.palette-item', '前往 队列')
      await sleep(450)
      out.titleAfter = text(document.querySelector('.cmd-title h1'))
      out.paletteClosed = !document.querySelector('.palette')
      out.queueRows = document.querySelectorAll('.qrow').length
      return out
    })()
  `,

  /* Space toggles playback (transport button title/icon), restores on second press. */
  space: `
    (async () => {
      ${helpers}
      const play = () => document.querySelector('.transport-play')
      const icon = () => {
        const b = play()
        if (!b) return null
        const svg = b.querySelector('svg')
        return svg ? svg.getAttribute('class') : null
      }
      const out = {}
      out.titleBefore = play() ? play().title : null
      out.iconBefore = icon()
      key(' '); await sleep(220)
      out.titleAfter = play() ? play().title : null
      out.iconAfter = icon()
      key(' '); await sleep(220)
      out.titleRestored = play() ? play().title : null
      return out
    })()
  `,

  /* Ctrl+, opens settings; Escape closes it. */
  'ctrl-settings': `
    (async () => {
      ${helpers}
      const out = {}
      out.settingsBefore = Boolean(document.querySelector('.settings'))
      key(',', { ctrlKey: true }); await sleep(350)
      out.settingsAfterCtrlComma = Boolean(document.querySelector('.settings'))
      out.settingsTitle = text(document.querySelector('.settings-title h2'))
      out.navGroups = [...document.querySelectorAll('.settings-nav-item')].map((e) => text(e))
      key('Escape'); await sleep(350)
      out.settingsAfterEsc = Boolean(document.querySelector('.settings'))
      return out
    })()
  `,

  /* ?toast=1 pushes a toast (auto-dismisses after 2.4s). */
  toast: `
    (async () => {
      ${helpers}
      await sleep(60)
      const el = document.querySelector('.toast')
      return {
        toastVisible: Boolean(el),
        toastText: text(el),
        toastRect: rect(el),
        stackCount: document.querySelectorAll('.toast').length
      }
    })()
  `,

  /* ?confirm=1 shows the confirmation dialog; cancel closes it. */
  confirm: `
    (async () => {
      ${helpers}
      const out = {}
      out.dialogVisible = Boolean(document.querySelector('.dialog'))
      out.dialogTitle = text(document.querySelector('.dialog-title'))
      out.buttons = [...document.querySelectorAll('.dialog-actions button')].map((b) => text(b))
      out.dialogRect = rect(document.querySelector('.dialog'))
      clickText('.dialog-actions button', '取消'); await sleep(300)
      out.dialogAfterCancel = Boolean(document.querySelector('.dialog'))
      return out
    })()
  `,

  /* Synthetic HTML5 drag&drop reorder of queue rows (DragEvent + DataTransfer). */
  drag: `
    (async () => {
      ${helpers}
      const titles = () => [...document.querySelectorAll('.qrow .qtitle')].map((e) => e.textContent.trim())
      const out = { supported: typeof DragEvent === 'function' && typeof DataTransfer === 'function' }
      out.orderBefore = titles()
      const rows = [...document.querySelectorAll('.qrow')]
      if (!out.supported || rows.length < 4) { out.error = 'no rows or no DragEvent'; return out }
      const from = rows[3]
      const to = rows[1]
      const dt = new DataTransfer()
      try {
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
        await sleep(60)
        const b = to.getBoundingClientRect()
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: b.top + 2, clientX: b.left + 10 }))
        await sleep(60)
        out.draggingClass = from.className
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: b.top + 2, clientX: b.left + 10 }))
        await sleep(280)
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
        await sleep(120)
      } catch (error) {
        out.error = String(error)
      }
      out.orderAfter = titles()
      out.changed = JSON.stringify(out.orderBefore) !== JSON.stringify(out.orderAfter)
      return out
    })()
  `,

  /* Focus indicator: focus controls and report :focus-visible + computed outline. */
  focus: `
    (async () => {
      ${helpers}
      const probe = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return { sel, found: false }
        el.focus()
        const cs = getComputedStyle(el)
        return {
          sel,
          found: true,
          active: document.activeElement === el,
          focusVisible: el.matches(':focus-visible'),
          outlineWidth: cs.outlineWidth,
          outlineStyle: cs.outlineStyle,
          outlineColor: cs.outlineColor,
          outlineOffset: cs.outlineOffset
        }
      }
      const out = { probes: [] }
      out.probes.push(probe('.nav-item'))
      out.probes.push(probe('.btn-primary'))
      out.probes.push(probe('.side-item'))
      out.probes.push(probe('.qrow .row-btn'))
      return out
    })()
  `,

  /* WCAG contrast of rendered text pairings (computed colors, no guessing). */
  contrast: `
    (async () => {
      ${helpers}
      const parse = (str) => {
        const m = String(str).match(/rgba?\\(([^)]+)\\)/)
        if (!m) return null
        const p = m[1].split(',').map((n) => parseFloat(n))
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
      }
      const blend = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a)
      })
      const bgOf = (el) => {
        let cur = el
        while (cur && cur !== document.documentElement) {
          const cs = getComputedStyle(cur)
          if (cs.backgroundImage && cs.backgroundImage !== 'none') break
          const c = parse(cs.backgroundColor)
          if (c && c.a > 0.999) return c
          cur = cur.parentElement
        }
        const c = parse(getComputedStyle(document.body).backgroundColor)
        return c || { r: 255, g: 255, b: 255, a: 1 }
      }
      const lum = (c) => {
        const f = (v) => {
          v /= 255
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
      }
      const ratio = (a, b) => {
        const l1 = lum(a)
        const l2 = lum(b)
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      }
      const sels = [
        '.brand-name', '.brand-sub', '.conn', '.titlebar-placeholder', '.kbd',
        '.cmd-title h1', '.cmd-kicker', '.seg:not(.active)', '.chip-btn', '.btn-primary',
        '.label', '.text-btn', '.statusbar .status-hint', '.statusbar .status-item', '.statusbar .status-strong',
        '.hero-kicker', '.hero-artist', '.hero-album', '.hero-chips .chip', '.progress-times',
        '.upnext-artist', '.upnext-by', '.upnext-dur',
        '.lyric-line.active', '.lyric-line.active .lyric-trans',
        '.qhead > span', '.qrow .qtitle', '.qrow .col-artist', '.qrow .col-by', '.qrow .col-likes', '.qrow .col-dur',
        '.source-chip', '.queue-foot-hint', '.queue-foot .label',
        '.hhead > span', '.hrow .halbum', '.hrow .htime', '.hrow .hdur', '.hrow .stitle', '.hrow .sartist',
        '.srow .stitle', '.srow .sartist', '.srow .salbum', '.srow .sdur', '.search-trending .chip-link',
        '.chat-time', '.chat-sys', '.chat-name', '.chat-text',
        '.setting-desc', '.settings-version', '.kv-k', '.shortcut-row',
        '.service-meta', '.room-stat-key', '.status-pill.ok', '.status-pill.warn',
        '.state-text', '.state-title',
        '.palette-input input', '.palette-desc', '.palette-group', '.palette-hint',
        '.dialog-title', '.dialog-body', '.toast'
      ]
      const out = { view: new URLSearchParams(location.search).get('view') || 'party', samples: [], low: [] }
      const seen = new Set()
      for (const sel of sels) {
        const el = document.querySelector(sel)
        if (!el || seen.has(el)) continue
        seen.add(el)
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
        const fg = parse(cs.color)
        if (!fg) continue
        const bg = bgOf(el)
        const solidFg = blend(fg, bg)
        const r = ratio(solidFg, bg)
        const size = parseFloat(cs.fontSize)
        const weight = parseInt(cs.fontWeight, 10) || 400
        const large = size >= 24 || (size >= 18.66 && weight >= 700)
        const need = large ? 3 : 4.5
        const row = {
          sel,
          text: text(el).slice(0, 26),
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          color: cs.color,
          bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
          ratio: +r.toFixed(2),
          need,
          pass: r >= need
        }
        out.samples.push(row)
        if (!row.pass) out.low.push(row)
      }
      out.sampleCount = out.samples.length
      out.failCount = out.low.length
      return out
    })()
  `,

  /* Empty-ground audit: sidebar / workspace / inspector dead space. */
  emptiness: `
    (async () => {
      ${helpers}
      const out = {}
      const sidebar = document.querySelector('.sidebar')
      if (sidebar) {
        const groups = [...document.querySelectorAll('.sidebar-scroll .side-group')]
        const last = groups[groups.length - 1]
        const foot = document.querySelector('.sidebar-foot')
        const lastBottom = last ? last.getBoundingClientRect().bottom : null
        const footTop = foot ? foot.getBoundingClientRect().top : null
        out.sidebar = {
          rect: rect(sidebar),
          groupCount: groups.length,
          groupsBottom: lastBottom != null ? +lastBottom.toFixed(1) : null,
          footTop: footTop != null ? +footTop.toFixed(1) : null,
          gap: lastBottom != null && footTop != null ? +(footTop - lastBottom).toFixed(1) : null,
          gapRatio: lastBottom != null && footTop != null ? +(((footTop - lastBottom) / sidebar.getBoundingClientRect().height) * 100).toFixed(1) : null
        }
      }
      const workspace = document.querySelector('.workspace')
      const inner = document.querySelector('.workspace-inner')
      if (workspace && inner) {
        const children = [...inner.children]
        const lastChild = children[children.length - 1]
        const wsRect = workspace.getBoundingClientRect()
        const lastRect = lastChild ? lastChild.getBoundingClientRect() : null
        out.workspace = {
          rect: rect(workspace),
          innerHeight: +inner.getBoundingClientRect().height.toFixed(1),
          lastChildBottom: lastRect ? +lastRect.bottom.toFixed(1) : null,
          viewportBottom: +wsRect.bottom.toFixed(1),
          emptyBelow: lastRect ? +(wsRect.bottom - lastRect.bottom).toFixed(1) : null
        }
      }
      const insp = document.querySelector('.inspector')
      if (insp) {
        const kids = [...insp.children]
        const lastKid = kids[kids.length - 1]
        const ir = insp.getBoundingClientRect()
        out.inspector = {
          rect: rect(insp),
          lastChildBottom: lastKid ? +lastKid.getBoundingClientRect().bottom.toFixed(1) : null,
          emptyBelow: lastKid ? +(ir.bottom - lastKid.getBoundingClientRect().bottom).toFixed(1) : null
        }
      }
      return out
    })()
  `,

  /* Row context menu: right-click opens the system-styled menu. */
  'context-menu': `
    (async () => {
      ${helpers}
      const row = document.querySelector('.qrow')
      if (!row) return { error: 'no .qrow' }
      const b = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 80, clientY: b.top + 20, button: 2 }))
      await sleep(300)
      const menu = document.querySelector('.ctxmenu')
      const out = {
        menuVisible: Boolean(menu),
        items: [...document.querySelectorAll('.ctx-item')].map((e) => text(e)),
        rect: rect(menu)
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(250)
      out.menuAfterEsc = Boolean(document.querySelector('.ctxmenu'))
      return out
    })()
  `,

  /* Header/body text-edge alignment inside data tables. */
  align: `
    (async () => {
      ${helpers}
      const x = (el) => (el ? +el.getBoundingClientRect().x.toFixed(1) : null)
      const pair = (headSel, rowSel) => ({ head: x(document.querySelector(headSel)), row: x(document.querySelector(rowSel)) })
      const out = { view: new URLSearchParams(location.search).get('view') || 'party' }
      if (document.querySelector('.qhead')) {
        out.queue = {
          track: pair('.qhead .col-track', '.qrow .qtitle'),
          artist: pair('.qhead .col-artist', '.qrow .col-artist'),
          source: pair('.qhead .col-source', '.qrow .col-source .source-chip'),
          by: pair('.qhead .col-by', '.qrow .col-by'),
          dur: pair('.qhead .col-dur', '.qrow .col-dur'),
          actions: pair('.qhead .col-actions', '.qrow .col-actions .row-btn')
        }
        const textX = (el) => {
          if (!el) return null
          const cs = getComputedStyle(el)
          return +(el.getBoundingClientRect().x + (parseFloat(cs.paddingLeft) || 0)).toFixed(1)
        }
        const head = document.querySelector('.qhead .col-track')
        const title = document.querySelector('.qrow .qtitle')
        out.queueTrackText = {
          headTextX: textX(head),
          rowTitleX: title ? +title.getBoundingClientRect().x.toFixed(1) : null,
          diff: head && title ? +(textX(head) - title.getBoundingClientRect().x).toFixed(1) : null,
          headPaddingLeft: head ? getComputedStyle(head).paddingLeft : null,
          handleW: (() => { const h = document.querySelector('.qrow .drag-handle'); return h ? +h.getBoundingClientRect().width.toFixed(1) : null })(),
          coverW: (() => { const c = document.querySelector('.qrow .qcover'); return c ? +c.getBoundingClientRect().width.toFixed(1) : null })()
        }
      }
      if (document.querySelector('.hhead')) {
        out.history = {
          track: pair('.hhead .col-track', '.hrow .hinfo .stitle'),
          album: pair('.hhead .halbum', '.hrow .halbum'),
          source: pair('.hhead .hsource', '.hrow .hsource .source-chip'),
          by: pair('.hhead .hby', '.hrow .hby'),
          time: pair('.hhead .htime', '.hrow .htime'),
          dur: pair('.hhead .hdur', '.hrow .hdur'),
          actions: pair('.hhead .hactions', '.hrow .hactions .sadd')
        }
        out.historyHeaderRows = (() => {
          const head = document.querySelector('.hhead')
          const tops = [...head.children].map((el) => +el.getBoundingClientRect().top.toFixed(1))
          const base = Math.min(...tops)
          return { tops, wrappedCount: tops.filter((t) => t > base + 6).length, headHeight: +head.getBoundingClientRect().height.toFixed(1) }
        })()
      }
      return out
    })()
  `,

  /* Nav rail destination switch via click (pointer path, not keyboard). */
  nav: `
    (async () => {
      ${helpers}
      const out = { titleBefore: text(document.querySelector('.cmd-title h1')) }
      const items = [...document.querySelectorAll('.nav-item')]
      out.navItems = items.map((e) => e.title || text(e))
      const target = items.find((e) => (e.title || '') === '队列') || items[1]
      if (target) target.click()
      await sleep(450)
      out.titleAfter = text(document.querySelector('.cmd-title h1'))
      out.queueRows = document.querySelectorAll('.qrow').length
      out.activeNav = text(document.querySelector('.nav-item.active'))
      return out
    })()
  `,

  /* Force the inspector open at the 1024 minimum width and check for squeeze/overflow. */
  'inspector-open': `
    (async () => {
      ${helpers}
      const out = { viewport: { w: innerWidth, h: innerHeight } }
      const ws = () => {
        const el = document.querySelector('.workspace')
        return el ? { w: +el.getBoundingClientRect().width.toFixed(1), scrollW: el.scrollWidth, clientW: el.clientWidth } : null
      }
      const insp = () => {
        const el = document.querySelector('.inspector')
        return el ? rect(el) : null
      }
      out.inspectorBefore = insp()
      out.workspaceBefore = ws()
      const toggle = document.querySelector('.chip-btn.icon-only')
      out.toggleFound = Boolean(toggle)
      if (toggle) toggle.click()
      await sleep(500)
      out.inspectorAfter = insp()
      out.workspaceAfter = ws()
      const de = document.documentElement
      out.documentOverflowX = de.scrollWidth - de.clientWidth
      const overflow = []
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue
        const b = el.getBoundingClientRect()
        if (b.width < 1 || b.height < 1) continue
        if (b.right > innerWidth + 1 || b.left < -1) overflow.push({ cls: String(el.className).slice(0, 50), left: +b.left.toFixed(1), right: +b.right.toFixed(1) })
      }
      out.overflowCount = overflow.length
      out.overflowSamples = overflow.slice(0, 6)
      const grid = document.querySelector('.qgrid')
      out.qgrid = grid ? { w: +grid.getBoundingClientRect().width.toFixed(1), scrollW: grid.scrollWidth, clientW: grid.clientWidth } : null
      if (grid) out.gridTemplateColumns = getComputedStyle(grid).gridTemplateColumns
      out.trackCell = (() => {
        const title = document.querySelector('.qrow .qtitle')
        const artist = document.querySelector('.qrow .col-artist')
        if (!title) return null
        return {
          titleW: +title.getBoundingClientRect().width.toFixed(1),
          titleScrollW: title.scrollWidth,
          titleText: text(title),
          artistW: artist ? +artist.getBoundingClientRect().width.toFixed(1) : null,
          artistScrollW: artist ? artist.scrollWidth : null
        }
      })()
      const clipped = []
      for (const el of document.querySelectorAll('.qrow span, .qrow div')) {
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) clipped.push({ cls: String(el.className).slice(0, 30), text: text(el).slice(0, 20), scrollW: el.scrollWidth, clientW: el.clientWidth })
      }
      out.trackClipped = clipped.slice(0, 6)
      await sleep(150)
      out.toast = text(document.querySelector('.toast'))
      return out
    })()
  `,

  /* Command bar primary action wiring per view. */
  primary: `
    (async () => {
      ${helpers}
      const out = {}
      const partyBtn = document.querySelector('.commandbar .btn-primary')
      out.partyLabel = text(partyBtn)
      if (partyBtn) partyBtn.click()
      await sleep(350)
      out.partyToast = text(document.querySelector('.toast'))
      const nav = [...document.querySelectorAll('.nav-item')].find((e) => (e.title || text(e)) === '队列')
      if (nav) nav.click()
      await sleep(500)
      out.queueTitleBefore = text(document.querySelector('.cmd-title h1'))
      out.queueLabel = text(document.querySelector('.commandbar .btn-primary'))
      const queueBtn = document.querySelector('.commandbar .btn-primary')
      if (queueBtn) queueBtn.click()
      await sleep(500)
      out.queueTitleAfter = text(document.querySelector('.cmd-title h1'))
      out.searchInput = Boolean(document.querySelector('.search-field input'))
      return out
    })()
  `,

  /* Native controls that break the drawn-chrome system + window controls presence. */
  chrome: `
    (async () => {
      ${helpers}
      const out = {}
      out.desktopApi = Boolean(window.mpDesktop)
      out.titlebar = {
        winButtons: document.querySelectorAll('.titlebar .winbtn').length,
        titles: [...document.querySelectorAll('.titlebar .winbtn')].map((e) => e.title),
        searchEntry: Boolean(document.querySelector('.titlebar-search')),
        settingsButton: Boolean(document.querySelector('.titlebar .tb-btn'))
      }
      out.nativeSelects = [...document.querySelectorAll('select')].map((s) => ({ cls: s.className, value: s.value, options: s.options.length }))
      out.nativeRange = document.querySelectorAll('input[type="range"]').length
      out.nativeNumber = document.querySelectorAll('input[type="number"]').length
      out.windowFrame = { titlebarH: rect(document.querySelector('.titlebar')), statusbarH: rect(document.querySelector('.statusbar')) }
      return out
    })()
  `,

  /* Focus ring visibility on the dark active palette item. */
  'focus-palette': `
    (async () => {
      ${helpers}
      key('k', { ctrlKey: true }); await sleep(250)
      const item = document.querySelector('.palette-item.active')
      const out = { found: Boolean(item) }
      if (item) {
        item.focus()
        await sleep(80)
        const cs = getComputedStyle(item)
        out.active = document.activeElement === item
        out.focusVisible = item.matches(':focus-visible')
        out.bg = cs.backgroundColor
        out.color = cs.color
        out.outlineWidth = cs.outlineWidth
        out.outlineStyle = cs.outlineStyle
        out.outlineColor = cs.outlineColor
        out.outlineOffset = cs.outlineOffset
      }
      return out
    })()
  `,

  /* Audio-engine state + spectrum canvas coverage (demo mode idle check). */
  viz: `
    (async () => {
      ${helpers}
      const out = { handles: Object.keys(window.__mp || {}) }
      const mp = window.__mp || {}
      try {
        out.playback = mp.playback ? JSON.parse(JSON.stringify(mp.playback)) : null
      } catch { out.playback = 'unserializable' }
      const cover = (sel) => {
        const c = document.querySelector(sel)
        if (!c) return null
        const ctx = c.getContext('2d')
        if (!ctx) return { noContext: true }
        const w = c.width
        const h = c.height
        let painted = 0
        let minY = h
        let maxY = 0
        let samples = 0
        const d = ctx.getImageData(0, 0, w, h).data
        for (let y = 0; y < h; y += 2) {
          for (let x = 0; x < w; x += 2) {
            samples += 1
            const i = (y * w + x) * 4
            if (d[i + 3] > 16) {
              painted += 1
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        return {
          w,
          h,
          paintedRatio: +(painted / samples).toFixed(4),
          topPaint: minY === h ? null : minY,
          bottomPaint: maxY,
          maxBarRatio: minY === h ? 0 : +((h - minY) / h).toFixed(3)
        }
      }
      out.canvas = cover('.viz-canvas')
      await sleep(1000)
      out.canvasLater = cover('.viz-canvas')
      out.playing = (() => {
        try {
          return JSON.parse(JSON.stringify(mp.engine ? mp.engine.state || mp.engine.active || {} : {}))
        } catch {
          return null
        }
      })()
      return out
    })()
  `,

  /* Layout metrics: overflow, 40px rows, header/body column alignment, clipped text. */
  metrics: `
    (async () => {
      ${helpers}
      const out = { view: new URLSearchParams(location.search).get('view') || 'party', viewport: { w: innerWidth, h: innerHeight } }
      const de = document.documentElement
      out.documentOverflowX = de.scrollWidth - de.clientWidth
      out.documentOverflowY = de.scrollHeight - de.clientHeight

      const box = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        return { ...rect(el), scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight }
      }
      out.commandbar = box('.commandbar')
      out.titlebar = box('.titlebar')
      out.statusbar = box('.statusbar')
      out.workspace = box('.workspace')
      out.mpMain = box('.mp-main')
      out.sidebar = box('.sidebar')
      out.inspector = box('.inspector')

      // elements sticking outside the viewport horizontally
      const overflow = []
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue
        const b = el.getBoundingClientRect()
        if (b.width < 1 || b.height < 1) continue
        if (b.right > innerWidth + 1 || b.left < -1) {
          overflow.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), left: +b.left.toFixed(1), right: +b.right.toFixed(1) })
        }
      }
      out.overflowCount = overflow.length
      out.overflowSamples = overflow.slice(0, 8)

      // clipped single-line text (truncation)
      const clipped = []
      for (const el of document.querySelectorAll('span, div, h1, h2, a, button')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
          if (own) clipped.push({ cls: String(el.className).slice(0, 50), text: text(el).slice(0, 40), scrollW: el.scrollWidth, clientW: el.clientWidth })
        }
      }
      out.clippedCount = clipped.length
      out.clippedSamples = clipped.slice(0, 10)

      // row heights
      const rowHeights = (sel) => [...document.querySelectorAll(sel)].slice(0, 6).map((el) => +el.getBoundingClientRect().height.toFixed(2))
      out.qrowHeights = rowHeights('.qrow')
      out.hrowHeights = rowHeights('.hrow')
      out.srowHeights = rowHeights('.srow')

      // header vs first row column positions
      const colXs = (rootSel) => {
        const root = document.querySelector(rootSel)
        if (!root) return null
        return [...root.children].map((el) => {
          const b = el.getBoundingClientRect()
          return { cls: String(el.className).slice(0, 30), x: +b.x.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1) }
        })
      }
      out.qheadCols = colXs('.qhead')
      out.qrowCols = colXs('.qrow')
      out.hheadCols = colXs('.hhead')
      out.hrowCols = colXs('.hrow')

      // offline banner geometry (when present)
      const bar = document.querySelector('.reconnect-bar')
      if (bar) {
        out.reconnectBar = {
          rect: rect(bar),
          offsetH: bar.offsetHeight,
          scrollH: bar.scrollHeight,
          computedHeight: getComputedStyle(bar).height,
          text: text(bar),
          buttonRect: rect(bar.querySelector('button'))
        }
      }
      return out
    })()
  `,

  /* Offline banner: loaded via ?offline=1 and runtime-triggered via palette. */
  banner: `
    (async () => {
      ${helpers}
      const out = {}
      const measure = () => {
        const bar = document.querySelector('.reconnect-bar')
        if (!bar) return null
        return {
          rect: rect(bar),
          offsetH: bar.offsetHeight,
          scrollH: bar.scrollHeight,
          computedHeight: getComputedStyle(bar).height,
          overflow: getComputedStyle(bar).overflow,
          text: text(bar),
          buttonRect: rect(bar.querySelector('button')),
          connClass: document.querySelector('.conn') ? document.querySelector('.conn').className : null
        }
      }
      out.loadedOffline = measure()
      await sleep(1000)
      out.loadedOfflineAfterWait = measure()
      // runtime trigger via the palette dev command (label contains "断线")
      key('k', { ctrlKey: true }); await sleep(250)
      out.triggered = clickText('.palette-item', '断线')
      await sleep(700)
      out.runtime = measure()
      await sleep(1000)
      out.runtimeAfterWait = measure()
      const btn = document.querySelector('.reconnect-bar button')
      if (btn) btn.click()
      await sleep(450)
      out.afterReconnectClick = { banner: Boolean(document.querySelector('.reconnect-bar')), conn: text(document.querySelector('.conn')) }
      return out
    })()
  `
}

const args = process.argv.slice(2)
const testId = args[0]
if (!testId || !TESTS[testId]) {
  console.error('[qa-interact] usage: node scripts/qa-interact.cjs <' + Object.keys(TESTS).join('|') + '> [options]')
  process.exit(2)
}
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const view = opt('view', '')
const width = opt('width', '1440')
const height = opt('height', '900')
const extra = opt('extra', '')
const wait = Number(opt('wait', '1500'))
const shot = opt('shot', '')

const electron = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

fs.mkdirSync(TMP_DIR, { recursive: true })
const evalFile = path.join(TMP_DIR, testId + '.js')
fs.writeFileSync(evalFile, TESTS[testId], 'utf8')

env.MP_EVAL_FILE = evalFile
env.MP_EVAL_WAIT = String(wait)
if (view) env.MP_SHOT_VIEW = view
env.MP_SHOT_W = String(width)
env.MP_SHOT_H = String(height)
if (extra) env.MP_SHOT_EXTRA = extra
if (shot) {
  env.MP_SHOT = '1'
  env.MP_SHOT_OUT = shot
}

const child = spawn(electron, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => (stdout += d.toString()))
child.stderr.on('data', (d) => (stderr += d.toString()))
const timer = setTimeout(() => {
  console.error('[qa-interact] timeout - killing Electron')
  child.kill()
}, 40000)

child.on('close', (code) => {
  clearTimeout(timer)
  const line = stdout.split(/\r?\n/).find((l) => l.includes('[eval] result '))
  const failed = stdout.split(/\r?\n/).find((l) => l.includes('[eval] failed '))
  console.log('[qa-interact] test=' + testId + ' view=' + (view || 'party') + ' size=' + width + 'x' + height + (extra ? ' extra=' + extra : '') + ' exit=' + code)
  if (failed) console.log('[qa-interact] ' + failed.trim())
  const errLines = stderr.split(/\r?\n/).filter((l) => l.includes('[eval]'))
  if (errLines.length) console.log('[qa-interact] stderr(eval): ' + errLines.join(' | '))
  if (!line) {
    console.log('[qa-interact] no eval result parsed')
    process.exit(1)
  }
  const idx = line.indexOf('[eval] result ')
  const raw = line.slice(idx + '[eval] result '.length)
  console.log('[qa-interact] result ' + raw)
  process.exit(0)
})
child.on('error', (err) => {
  clearTimeout(timer)
  console.error('[qa-interact] spawn failed', err)
  process.exit(1)
})

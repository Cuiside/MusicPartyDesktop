'use strict'
// QA final verification battery: runs the screen captures (optional) plus every
// interaction / layout / contrast probe in one serial pass and prints a PASS/FAIL
// table. One Electron at a time. Safe to re-run; the full report lives in
// docs/QA_REPORT.md.
//
// Usage:
//   node scripts/qa-verify.cjs                  # interaction + layout probes
//   node scripts/qa-verify.cjs --with-capture   # also re-shoot the 24 screenshots
//   node scripts/qa-verify.cjs --only contrast,emptiness
//
// Log: screenshots/qa/_eval/verify-<stamp>.log
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const LOG_DIR = path.join(ROOT, 'screenshots', 'qa', '_eval')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
const LOG = path.join(LOG_DIR, `verify-${stamp}.log`)

const args = process.argv.slice(2)
const withCapture = args.includes('--with-capture')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? new Set(String(args[onlyIdx + 1] || '').split(',').filter(Boolean)) : null

const VIEWS = ['party', 'queue', 'search', 'chat', 'history', 'console', 'settings', 'states']
const WIDTHS = [
  { tag: '1440', w: 1440, h: 900 },
  { tag: '1024', w: 1024, h: 768 }
]

/* id, extra args, assertion (result) => {pass, notes[]} */
const INTERACTIVE = [
  {
    id: 'palette',
    opts: ['--view', 'party'],
    assert: (r) => ({
      pass: r.openAfterCtrlK === true && r.inputFocused === true && r.openAfterEsc === false && r.itemsFiltered > 0 && r.itemsFiltered < r.itemsTotal,
      notes: [`items ${r.itemsTotal}->${r.itemsFiltered}`, `escClosed=${r.openAfterEsc === false}`]
    })
  },
  {
    id: 'palette-jump',
    opts: ['--view', 'party'],
    assert: (r) => ({ pass: r.titleAfter === '队列' && r.paletteClosed === true && r.queueRows > 0, notes: [`title=${r.titleAfter}`, `rows=${r.queueRows}`] })
  },
  {
    id: 'space',
    opts: ['--view', 'party'],
    assert: (r) => ({
      pass: r.titleAfter && r.titleAfter !== r.titleBefore && r.titleRestored === r.titleBefore,
      notes: [`${r.titleBefore}->${r.titleAfter}->${r.titleRestored}`]
    })
  },
  {
    id: 'ctrl-settings',
    opts: ['--view', 'party'],
    assert: (r) => ({ pass: r.settingsAfterCtrlComma === true && r.settingsAfterEsc === false && r.navGroups.length === 5, notes: [`title=${r.settingsTitle}`, `groups=${r.navGroups.length}`] })
  },
  {
    id: 'toast',
    opts: ['--view', 'party', '--extra', 'toast=1', '--wait', '1200'],
    assert: (r) => ({ pass: r.toastVisible === true, notes: [`toast="${r.toastText}"`] })
  },
  {
    id: 'confirm',
    opts: ['--view', 'party', '--extra', 'confirm=1', '--wait', '1200'],
    assert: (r) => ({ pass: r.dialogVisible === true && r.dialogAfterCancel === false, notes: [`title="${r.dialogTitle}"`, `buttons=${r.buttons.join('/')}`] })
  },
  {
    id: 'drag',
    opts: ['--view', 'queue'],
    assert: (r) => ({ pass: r.changed === true, notes: [`before[1..3]=${r.orderBefore.slice(1, 4).join(',')}`, `after[1..3]=${r.orderAfter.slice(1, 4).join(',')}`] })
  },
  {
    id: 'focus',
    opts: ['--view', 'party'],
    assert: (r) => {
      const found = r.probes.filter((p) => p.found)
      const pass =
        found.length >= 2 &&
        found.every((p) => p.focusVisible === true && p.outlineStyle === 'solid' && p.outlineWidth === '2px') &&
        found.some((p) => p.sel === '.nav-item') &&
        found.some((p) => p.sel === '.btn-primary')
      return { pass, notes: found.map((p) => `${p.sel}:${p.focusVisible ? 'visible' : 'HIDDEN'} outline=${p.outlineWidth} ${p.outlineStyle}`) }
    }
  },
  {
    id: 'context-menu',
    opts: ['--view', 'queue'],
    assert: (r) => ({ pass: r.menuVisible === true && r.menuAfterEsc === false && r.items.length >= 5, notes: [`items=${r.items.length}`, `escClosed=${r.menuAfterEsc === false}`] })
  },
  {
    id: 'nav',
    opts: ['--view', 'party'],
    assert: (r) => ({ pass: r.titleAfter === '队列' && r.queueRows === 15, notes: [`${r.titleBefore}->${r.titleAfter}`, `rows=${r.queueRows}`] })
  },
  {
    id: 'banner',
    opts: ['--view', 'party', '--extra', 'offline=1', '--wait', '2500'],
    assert: (r) => ({
      pass:
        r.loadedOffline &&
        r.loadedOffline.rect.h >= 30 &&
        r.loadedOfflineAfterWait.rect.h >= 30 &&
        /断开/.test(r.loadedOffline.text || '') &&
        r.loadedOffline.buttonRect &&
        r.loadedOffline.buttonRect.w > 20 &&
        r.afterReconnectClick.banner === false,
      notes: [`bannerH=${r.loadedOffline ? r.loadedOffline.rect.h : 'missing'}`, `buttonW=${r.loadedOffline && r.loadedOffline.buttonRect ? r.loadedOffline.buttonRect.w : 'n/a'}`, `reconnectCleared=${r.afterReconnectClick && !r.afterReconnectClick.banner}`]
    })
  },
  {
    id: 'inspector-open',
    opts: ['--view', 'queue', '--width', '1024', '--height', '768', '--wait', '1500'],
    assert: (r) => ({
      pass: r.inspectorAfter === null && Boolean(r.toast) && /过窄/.test(r.toast || '') && r.documentOverflowX === 0 && /346(?:\.\d+)?px/.test(r.gridTemplateColumns || ''),
      notes: [`inspector=${r.inspectorAfter === null ? 'blocked' : 'OPENED'}`, `toast="${r.toast}"`, `cols=${r.gridTemplateColumns}`]
    })
  },
  {
    id: 'primary',
    opts: ['--view', 'party'],
    assert: (r) => ({
      pass: /服务器地址已复制/.test(r.partyToast || '') && r.queueTitleAfter === '搜索' && r.searchInput === true,
      notes: [`partyToast="${r.partyToast}"`, `queue:${r.queueTitleBefore}->${r.queueTitleAfter}`]
    })
  },
  {
    id: 'chrome',
    opts: ['--view', 'settings'],
    assert: (r) => ({ pass: r.titlebar.winButtons === 3 && r.desktopApi === true, notes: [`nativeSelects=${r.nativeSelects.length}`, `winButtons=${r.titlebar.winButtons}`] })
  },
  {
    id: 'palette-jump-search',
    opts: ['--view', 'party'],
    assert: (r) => ({ pass: r.queueRows > 0, notes: ['alias smoke'] }),
    skip: true
  }
].filter((t) => !t.skip)

function runNode(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? 0, out, err }))
    child.on('error', (e) => resolve({ code: 1, out, err: String(e) }))
  })
}

function parseResult(out) {
  const line = out.split(/\r?\n/).find((l) => l.includes('[qa-interact] result '))
  if (!line) return null
  const idx = line.indexOf('[qa-interact] result ')
  try {
    return JSON.parse(line.slice(idx + '[qa-interact] result '.length))
  } catch {
    return null
  }
}

function log(text) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.appendFileSync(LOG, text + '\n', 'utf8')
  console.log(text)
}

async function runInteractive() {
  const rows = []
  for (const t of INTERACTIVE) {
    if (only && !only.has(t.id)) continue
    log(`[verify] --- ${t.id} ---`)
    const started = Date.now()
    const res = await runNode([path.join(__dirname, 'qa-interact.cjs'), t.id, ...t.opts])
    log(res.out.trim())
    if (res.err.trim()) log('[stderr] ' + res.err.trim().split(/\r?\n/).slice(-3).join('\n'))
    const result = parseResult(res.out)
    let verdict
    if (!result) verdict = { pass: false, notes: ['no eval result parsed'] }
    else {
      try {
        verdict = t.assert(result)
      } catch (error) {
        verdict = { pass: false, notes: [String(error)] }
      }
    }
    rows.push({ id: t.id, pass: verdict.pass, notes: verdict.notes, ms: Date.now() - started })
  }
  return rows
}

async function runMetrics() {
  const rows = []
  for (const { tag, w, h } of WIDTHS) {
    for (const view of VIEWS) {
      if (only && !only.has('metrics')) continue
      const res = await runNode([path.join(__dirname, 'qa-interact.cjs'), 'metrics', '--view', view, '--width', String(w), '--height', String(h), '--wait', '1200'])
      const r = parseResult(res.out)
      const rowsToCheck = r ? r.qrowHeights.concat(r.hrowHeights) : []
      const rowHeightsOk = rowsToCheck.length === 0 || rowsToCheck.every((x) => Math.abs(x - 40) < 0.01)
      const pass = Boolean(r) && r.documentOverflowX === 0 && r.overflowCount === 0 && r.clippedCount === 0 && rowHeightsOk
      if (!r) log(`[verify] metrics ${view}@${tag}: NO RESULT`)
      rows.push({
        id: `metrics:${view}@${tag}`,
        pass,
        notes: r ? [`docX=${r.documentOverflowX}`, `overflow=${r.overflowCount}`, `clipped=${r.clippedCount}`, `rows=${rowHeightsOk ? '40px' : 'BAD'}`] : ['no result']
      })
    }
  }
  return rows
}

async function runAlign() {
  const rows = []
  for (const { tag, w, h } of WIDTHS) {
    for (const view of ['queue', 'history']) {
      if (only && !only.has('align')) continue
      const res = await runNode([path.join(__dirname, 'qa-interact.cjs'), 'align', '--view', view, '--width', String(w), '--height', String(h), '--wait', '1000'])
      const r = parseResult(res.out)
      let pass = false
      let notes = ['no result']
      if (r) {
        if (view === 'queue' && r.queue) {
          // The track cell starts before the drag handle/cover, so compare the
          // header *text* edge with the row title (the row cell x will differ).
          const cols = ['artist', 'source', 'by', 'dur']
          pass = cols.every((k) => Math.abs(r.queue[k].head - r.queue[k].row) < 8)
          const tt = r.queueTrackText
          if (!tt || tt.diff == null || Math.abs(tt.diff) >= 8) pass = false
          notes = cols.map((k) => `${k}:${r.queue[k].head}/${r.queue[k].row}`)
          if (tt) notes.unshift(`trackTextDiff=${tt.diff}`)
        } else if (view === 'history' && r.history) {
          const cols = ['track', 'album', 'source', 'by', 'time', 'dur']
          pass = cols.every((k) => Math.abs(r.history[k].head - r.history[k].row) < 8)
          notes = cols.map((k) => `${k}:${r.history[k].head}/${r.history[k].row}`)
        }
      }
      rows.push({ id: `align:${view}@${tag}`, pass, notes })
    }
  }
  return rows
}

async function runContrast() {
  const rows = []
  for (const view of VIEWS) {
    if (only && !only.has('contrast')) continue
    const res = await runNode([path.join(__dirname, 'qa-interact.cjs'), 'contrast', '--view', view, '--width', '1440', '--height', '900', '--wait', '1200'])
    const r = parseResult(res.out)
    rows.push({ id: `contrast:${view}`, pass: Boolean(r) && r.failCount === 0, notes: r ? [`fail=${r.failCount}/${r.sampleCount}`] : ['no result'] })
  }
  return rows
}

async function runEmptiness() {
  const rows = []
  for (const view of VIEWS) {
    if (only && !only.has('emptiness')) continue
    const res = await runNode([path.join(__dirname, 'qa-interact.cjs'), 'emptiness', '--view', view, '--width', '1440', '--height', '900', '--wait', '1200'])
    const r = parseResult(res.out)
    rows.push({
      id: `emptiness:${view}`,
      pass: Boolean(r) && (!r.sidebar || r.sidebar.gapRatio <= 50),
      notes: r && r.sidebar ? [`gapRatio=${r.sidebar.gapRatio}%`] : ['no sidebar (n/a)']
    })
  }
  return rows
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.writeFileSync(LOG, `# qa-verify ${stamp}\n`, 'utf8')
  const started = Date.now()
  const all = []

  if (withCapture) {
    log('[verify] captures: node scripts/qa-capture.cjs')
    const res = await runNode([path.join(__dirname, 'qa-capture.cjs')])
    log(res.out.trim().split(/\r?\n/).slice(-3).join('\n'))
    all.push({ id: 'captures', pass: res.code === 0, notes: ['scripts/qa-capture.cjs exit ' + res.code] })
  }

  log('[verify] interactive tests')
  all.push(...(await runInteractive()))
  log('[verify] layout metrics')
  all.push(...(await runMetrics()))
  log('[verify] header/body alignment')
  all.push(...(await runAlign()))
  log('[verify] contrast (WCAG2)')
  all.push(...(await runContrast()))
  log('[verify] empty ground')
  all.push(...(await runEmptiness()))

  log('\n[verify] ===== SUMMARY =====')
  let passed = 0
  for (const row of all) {
    const tag = row.pass ? 'PASS' : 'FAIL'
    if (row.pass) passed += 1
    log(`[verify] ${tag}  ${row.id}  ${row.notes.join(' | ')}`)
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  log(`[verify] TOTAL ${passed}/${all.length} passed in ${secs}s`)
  log(`[verify] log: ${LOG}`)
  process.exit(0)
}

main()

'use strict'
// QA deterministic screenshot sweep: all views + overlays at 1440x900 and 1024x768.
// Runs one Electron at a time (serial) — do not run two copies of this script concurrently.
//
// Usage:
//   node scripts/qa-capture.cjs                 # capture everything
//   node scripts/qa-capture.cjs party queue     # only the named targets (see TARGETS ids)
//   node scripts/qa-capture.cjs --width 1440    # only one width bucket
//
// Output: screenshots/qa/<width>-<name>.png
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SHOT = path.join(__dirname, 'shot.cjs')
const OUT_DIR = path.join(ROOT, 'screenshots', 'qa')

const WIDTHS = [
  { tag: '1440', w: 1440, h: 900 },
  { tag: '1024', w: 1024, h: 768 }
]

// id, view, extraQuery
const TARGETS = [
  { id: 'party', view: 'party', extra: '' },
  { id: 'queue', view: 'queue', extra: '' },
  { id: 'search', view: 'search', extra: '' },
  { id: 'chat', view: 'chat', extra: '' },
  { id: 'history', view: 'history', extra: '' },
  { id: 'console', view: 'console', extra: '' },
  { id: 'settings', view: 'settings', extra: '' },
  { id: 'states', view: 'states', extra: '' },
  { id: 'party-palette', view: 'party', extra: 'palette=1' },
  { id: 'party-confirm', view: 'party', extra: 'confirm=1' },
  { id: 'party-toast', view: 'party', extra: 'toast=1' },
  { id: 'party-offline', view: 'party', extra: 'offline=1' }
]

const args = process.argv.slice(2)
const widthIdx = args.indexOf('--width')
const onlyWidth = widthIdx >= 0 ? args[widthIdx + 1] : ''
const only = new Set(args.filter((a, i) => !a.startsWith('--') && i !== widthIdx + 1))

const widths = onlyWidth ? WIDTHS.filter((x) => x.tag === onlyWidth) : WIDTHS
if (!widths.length) {
  console.error(`[qa-capture] unknown width ${onlyWidth}; use 1440 or 1024`)
  process.exit(1)
}
const targets = only.size ? TARGETS.filter((t) => only.has(t.id)) : TARGETS
if (!targets.length) {
  console.error(`[qa-capture] no known target in ${[...only].join(', ')}`)
  process.exit(1)
}

fs.mkdirSync(OUT_DIR, { recursive: true })

function runOne({ out, view, w, h, extra }) {
  return new Promise((resolve) => {
    const rel = path.relative(ROOT, out)
    const argv = [SHOT, rel, view, String(w), String(h)]
    if (extra) argv.push(extra)
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      console.error('[qa-capture] spawn failed', err)
      resolve(1)
    })
  })
}

async function main() {
  let failures = 0
  let n = 0
  const total = widths.length * targets.length
  for (const { tag, w, h } of widths) {
    for (const t of targets) {
      n += 1
      const out = path.join(OUT_DIR, `${tag}-${t.id}.png`)
      console.log(`[qa-capture] (${n}/${total}) ${tag} ${t.id} ${w}x${h}${t.extra ? ' ?' + t.extra : ''}`)
      const code = await runOne({ out, view: t.view, w, h, extra: t.extra })
      if (code !== 0) failures += 1
    }
  }
  console.log(`[qa-capture] done: ${total} captures, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}

main()

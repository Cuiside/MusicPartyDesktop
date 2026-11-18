'use strict'
// Render the built window to screenshots/<name>.png.
// Usage: node scripts/shot.cjs node-01-party screenshots/node-01-party.png [view]
const { spawn } = require('node:child_process')
const path = require('node:path')

const electron = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const out = process.argv[2] || 'screenshots/window.png'
const view = process.argv[3] || ''
const width = process.argv[4] || ''
const height = process.argv[5] || ''
const extra = process.argv[6] || ''

env.MP_SHOT = '1'
env.MP_SHOT_OUT = out
env.MP_SHOT_WAIT = env.MP_SHOT_WAIT || '2000'
if (view) env.MP_SHOT_VIEW = view
if (width) env.MP_SHOT_W = width
if (height) env.MP_SHOT_H = height
if (extra) env.MP_SHOT_EXTRA = extra

const child = spawn(electron, ['.'], { stdio: 'inherit', env })
child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[shot] failed to launch Electron:', err)
  process.exit(1)
})

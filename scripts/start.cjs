'use strict'
// Launch Electron with a clean environment (the harness exports
// ELECTRON_RUN_AS_NODE=1 which would run the main script under plain Node).
const { spawn } = require('node:child_process')

const electron = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.'], { stdio: 'inherit', env })
child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[start] failed to launch Electron:', err)
  process.exit(1)
})

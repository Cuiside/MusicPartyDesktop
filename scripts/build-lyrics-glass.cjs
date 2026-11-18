'use strict'
// Build the small, per-window Windows helper; no system installation is needed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const source = path.join(root, 'native', 'lyrics-glass.c')
const output = path.join(root, 'bin', 'lyrics-glass.exe')
const receipt = path.join(root, 'bin', 'lyrics-glass-build.json')
fs.mkdirSync(path.dirname(output), {recursive:true})
const compiler = process.env.CC || 'gcc'
const result = spawnSync(compiler, ['-std=c11','-O2','-s','-mwindows','-Wl,--no-insert-timestamp','-o',output,source,'-luser32'], {cwd:root,encoding:'utf8',windowsHide:true})
if (result.error || result.status !== 0) { console.error(result.error?.message || result.stderr); process.exit(1) }
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
fs.writeFileSync(receipt, JSON.stringify({sourceSha256:hash(source),binarySha256:hash(output),target:'win32-x64'}, null, 2) + '\n')
console.log('Built per-window lyrics glass helper and integrity receipt.')

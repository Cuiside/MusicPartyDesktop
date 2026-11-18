import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const root = path.resolve(import.meta.dirname, '../..'), require = createRequire(import.meta.url)
const vite = await createServer({ root, configFile: path.join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } })
await vite.listen()
try {
  const code = '(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));const button=document.querySelector("[aria-label=用户帮助]");const all=[...document.querySelectorAll(".titlebar-right button")];const bounds=all.map(x=>x.getBoundingClientRect());button.focus();button.click();await wait(150);const dialog=document.querySelector(".help-dialog");const focus=document.activeElement.id==="help-search";document.querySelector("#help-search").value="静音";document.querySelector("#help-search").dispatchEvent(new Event("input",{bubbles:true}));await wait(50);const search=dialog.textContent.includes("播放控制")&&!dialog.textContent.includes("管理员终端");const header=getComputedStyle(dialog.querySelector("header")).backgroundColor;document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));await wait(50);return {button:!!button,visible:bounds.every(r=>r.right<=innerWidth&&r.left>=0),dialog:!!dialog,focus,search,header,closed:!document.querySelector(".help-dialog"),restored:document.activeElement===button}})()'
  const env = { ...process.env, MP_DEV: '1', MP_SHOT: '1', MP_SHOT_VIEW: 'party', MP_SHOT_W: '1024', MP_SHOT_H: '680', MP_EVAL: code, MP_EVAL_WAIT: '1500', MP_SHOT_OUT: path.join(os.tmpdir(), 'mp-help-ui.png') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['.'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', v => { output += v }); child.stderr.on('data', v => { output += v })
  const exit = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(-1) }, 30000); child.on('exit', value => { clearTimeout(timer); resolve(value) }) })
  const line = output.split('\n').find(value => value.startsWith('[eval] result '))
  const result = line ? JSON.parse(line.slice(14)) : { error: output.slice(-1500) }
  console.log(JSON.stringify({ exit, result }))
  assert.equal(exit, 0)
  for (const key of ['button', 'visible', 'dialog', 'focus', 'search', 'closed', 'restored']) assert.equal(result[key], true, key)
} finally { await vite.close() }


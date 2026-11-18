import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const password = process.env.MP_DIAG_ROOM
if (!password) throw new Error('Set MP_DIAG_ROOM')
const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const vite = await createServer({ root, configFile: path.join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } })
await vite.listen()
try {
  const code = `(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));const c=await import('/src/core/live/client.js');
    const ok=await c.joinRoom({serverUrl:'https://music.example.com',name:'游客音频验收',password:${JSON.stringify(password)}});
    for(let i=0;i<80&&!window.__mp.live.nowPlaying;i++)await wait(100);
    const l=window.__mp.live,e=window.__mp.engine;const track=!!l.nowPlaying;
    let start=0;for(let i=0;i<70;i++){if(e.playing&&e.currentTime>0){start=e.currentTime;break}await wait(100)}
    await wait(1800);const result={ok,track,serverPlaying:l.playing,enginePlaying:e.playing,ready:e.ready,
      progressAdvanced:e.currentTime>start+0.4,volume:e.volume,muted:e.muted,error:e.error,degraded:e.degraded,hasAnalyser:e.hasAnalyser};
    await c.leaveRoom();return result})()`
  const env = { ...process.env, MP_DEV: '1', MP_SHOT: '1', MP_SHOT_VIEW: 'party', MP_EVAL: code,
    MP_EVAL_WAIT: '1800', MP_SHOT_OUT: path.join(os.tmpdir(), 'mp-audio-prod-diagnostic.png') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['.'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d)
  const exit = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(-1) }, 30000); child.on('exit', code => { clearTimeout(timer); resolve(code) }) })
  const match = output.match(/\[eval\] result (.*)/)
  const result = match ? JSON.parse(match[1]) : { error: 'No result from Electron' }
  const pass = exit === 0 && result.ok && result.track && result.serverPlaying && result.enginePlaying && result.ready && result.progressAdvanced && !result.muted && result.volume > 0 && !result.error
  console.log(JSON.stringify({ pass, result }))
  if (!pass) process.exitCode = 1
} finally { await vite.close() }

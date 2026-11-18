import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const vite = await createServer({ root, configFile: path.join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } })
await vite.listen()
try {
  const code = `(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const c = await import('/src/core/live/client.js');
    const nickname = '桌面测试' + Date.now().toString().slice(-8);
    const ok = await c.joinRoom({ serverUrl: 'http://127.0.0.1:18993', name: nickname, password: ${JSON.stringify(process.env.MP_TEST_ROOM_PASSWORD || '')} });
    await wait(2000);
    const l = window.__mp.live;
    const identity = !!l.identity && l.identity.name === nickname && !l.identity.isGuest;
    const connected = l.connected && l.joined;
    const chat = await c.sendChat('桌面联调测试消息');
    await wait(1000);
    const received = l.chat.some(row => row.text === '桌面联调测试消息');
    const online = l.online;
    const api = await import('/src/core/live/api.js');
    const resourceApi = await api.usesResourceApi();
    await c.leaveRoom();
    return { ok, identity, connected, chatOk: chat.ok, received, online, resourceApi };
  })()`
  const env = { ...process.env, MP_DEV: '1', MP_SHOT: '1', MP_SHOT_VIEW: 'party', MP_EVAL: code, MP_EVAL_WAIT: '1500', MP_SHOT_OUT: path.join(os.tmpdir(), 'mp-upstream-local.png') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['.'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const exit = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(-1) }, 30000); child.on('exit', value => { clearTimeout(timer); resolve(value) }) })
  const marker = String.fromCharCode(91) + 'eval' + String.fromCharCode(93) + ' result '
  const line = output.split(String.fromCharCode(10)).find(value => value.startsWith(marker))
  const result = line ? JSON.parse(line.slice(marker.length)) : { error: output.slice(-1500) }
  const passed = exit === 0 && result.ok && result.identity && result.connected && result.chatOk && result.received && result.online > 0 && result.resourceApi
  console.log(JSON.stringify({ passed, result }))
  if (!passed) process.exitCode = 1
} finally { await vite.close() }

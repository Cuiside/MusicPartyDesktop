'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const exe = process.env.MP_TEST_EXE
if (!exe || !fs.existsSync(exe)) throw new Error('Set MP_TEST_EXE to the isolated unpacked application')
const port = () => new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject)
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) })
})
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

;(async () => {
  const serverPort = await port()
  let result = null
  const collector = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { try { result = JSON.parse(body) } catch {} res.writeHead(200); res.end('ok') })
  })
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve))
  const collectorPort = collector.address().port
  const code = `(async () => {
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const mp=window.mpDesktop;
    await mp.launcher.setConfig({serverIp:'127.0.0.1',serverPort:'${serverPort}',baseUrl:'http://127.0.0.1:${serverPort}',neteaseEnabled:false,bilibiliEnabled:false});
    const password=await mp.launcher.ensureLocalAdminPassword(); const started=await mp.launcher.start();
    let status; for(let i=0;i<120;i++){await sleep(250);status=await mp.launcher.status();if(status.services.java.state==='ready')break;}
    const pid=status?.services?.java?.pid;
    const setup=await mp.http.request({url:'http://127.0.0.1:${serverPort}/api/auth/setup',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-room'})});
    document.querySelector('#onb-tab-join')?.click(); await sleep(100);
    if(!document.querySelector('#onb-join-server'))document.querySelector('.onb-server-row')?.click(); await sleep(100);
    const set=(selector,value)=>{const el=document.querySelector(selector);if(!el)throw Error('missing '+selector);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
    set('#onb-nickname','Fixture Packaged');set('#onb-password','fixture-room');set('#onb-join-server','http://127.0.0.1:${serverPort}');
    document.querySelector('#onb-submit-join').click();
    for(let i=0;i<100&&!window.__mp.live.connected;i++)await sleep(100);
    const l=window.__mp.live; const report={passwordSet:password.ok,started:started.ok,ready:status?.services?.java?.state==='ready',pid,setup:setup.status,joined:l.joined,connected:l.connected};
    await mp.http.request({url:'http://127.0.0.1:${collectorPort}/result',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
    mp.window.close(); return new Promise(()=>{});
  })()`
  const env = { ...process.env, MP_EVAL: code, MP_EVAL_WAIT: '1500', MP_SHOT_EXTRA: 'welcome=1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, [], { cwd: path.dirname(exe), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', x => { output += x }); child.stderr.on('data', x => { output += x })
  try {
    const exit = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(-1) }, 60000); child.once('exit', value => { clearTimeout(timer); resolve(value) }) })
    assert.ok(result, `Missing packaged test result: ${output.slice(-1200)}`)
    assert.equal(exit, 0); assert.equal(result.passwordSet, true); assert.equal(result.started, true)
    assert.equal(result.ready, true); assert.equal(result.setup, 200); assert.equal(result.joined, true); assert.equal(result.connected, true)
    assert.ok(result.pid)
    for (let i = 0; i < 50 && alive(result.pid); i++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(alive(result.pid), false, 'packaged app must stop its Java process on exit')
    console.log(JSON.stringify({ passed: true, localJoin: true, exitCleanup: true }))
  } finally { await new Promise(resolve => collector.close(resolve)) }
})().catch(error => { console.error(error.message); process.exitCode = 1 })

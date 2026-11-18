'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { registerLauncher } = require('../../electron/launcher.cjs')
const root = path.resolve(__dirname, '../..')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-096-launcher-'))
const app = { getPath: () => userData, getAppPath: () => root, getVersion: () => '0.9.6', isPackaged: false, on() {}, removeListener() {} }
const ipcMain = { handle() {}, removeHandler() {} }
const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() }
const launcher = registerLauncher({app, ipcMain, safeStorage})
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p=s.address().port; s.close(() => resolve(p)) }) })
async function main() {
 const port = await freePort()
 assert.equal(launcher.setSecrets({adminPassword:'fixture-admin-096'}).ok, true)
 assert.equal(launcher.setConfig({serverPort:String(port), neteaseEnabled:false, bilibiliEnabled:false, qqmusicEnabled:true}).ok, true)
 try {
  const start = await launcher.start()
  assert.equal(start.ok, true, JSON.stringify(start))
  const arg = launcher.getDiagnostics().javaArgs.find(s => s.startsWith('--app.music-api.qqmusic.base-url='))
  assert.ok(arg, 'QQ runtime should be healthy and passed to Java')
  const base = 'http://127.0.0.1:' + port
  let catalog
  for(let i=0;i<100;i++) { try { const r=await fetch(base+'/api/v2/sources',{headers:{'X-Room-Password':'fixture-admin-096'}}); if(r.ok){catalog=await r.json();break} } catch {} await new Promise(r=>setTimeout(r,200)) }
  assert.ok(catalog, 'server did not start')
  assert.ok(catalog.sources.some(s=>s.id==='qqmusic'), 'QQ source absent from catalog')
  const qqBase=arg.split('=').slice(1).join('=')
  const health=await (await fetch(qqBase+'/')).json()
  assert.equal(health.code,0)
  console.log('Real launcher started QQ sidecar and Java, exposed QQ source, and passed readiness checks.')
  assert.equal((await launcher.stop()).ok,true)
  await assert.rejects(fetch(qqBase+'/'))
  console.log('Real launcher stopped Java and QQ sidecar.')
 } finally { await launcher.stop(); launcher.dispose() }
}
main().catch(e=>{console.error(e);process.exitCode=1})

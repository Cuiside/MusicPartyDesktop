import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { startServer } from '../regression/lib/server.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const jar = process.env.MP_TEST_JAR
const java = process.env.MP_TEST_JAVA
if (!jar || !java) throw new Error('Set MP_TEST_JAR and MP_TEST_JAVA explicitly')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-playlist-test-'))
const events = []
const tracks = Array.from({ length: 53 }, (_, i) => ({
  id: String(1000 + i), name: `Fixture Song ${i + 1}`, dt: 120000,
  ar: [{ name: 'Fixture Artist' }], artists: [{ name: 'Fixture Artist' }], al: { picUrl: '' }
}))
let upstream, backend, vite
const listen = (server, port) => new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    events.push({ path: url.pathname, type: url.searchParams.get('type'), offset: url.searchParams.get('offset') })
    let body = { code: 200 }
    if (url.pathname === '/search' && url.searchParams.get('type') === '1002') {
      body.result = { userprofiles: [{ userId: 101, nickname: 'Alice Fixture' }, { userId: 202, nickname: 'Bob Fixture' }] }
    } else if (url.pathname === '/search') {
      body.result = { songs: [tracks[0]] }
    } else if (url.pathname === '/user/playlist') {
      body.playlist = [{ id: 301, name: 'Fixture Playlist', coverImgUrl: '', trackCount: 53 }]
    } else if (url.pathname === '/playlist/track/all') {
      const start = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 50)
      body.songs = tracks.slice(start, start + limit)
    } else if (url.pathname === '/song/detail') {
      body.songs = tracks.filter(t => (url.searchParams.get('ids') || '').split(',').includes(t.id))
    } else if (url.pathname.startsWith('/song/url')) {
      body.data = [{ id: url.searchParams.get('id'), code: 200, url: 'https://example.invalid/song.mp3', time: 120000 }]
    } else if (url.pathname === '/lyric') body.lrc = { lyric: '[00:00.00]Fixture' }
    else if (url.pathname === '/user/account') body.profile = { userId: 101 }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
  })
  await listen(upstream, 19349)
  backend = await startServer({ jar, java, port: 19348, upstreamPort: 19349, dataDir: temp,
    adminPassword: 'fixture-admin-password', neteaseCookie: 'MUSIC_U=valid-fixture',
    args: ['--app.music-api.room.rest-protection.enabled=true'] })
  await fetch(`${backend.base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-room' }) })
  vite = await createServer({ root, configFile: path.join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } })
  await vite.listen()

  const code = `(async()=>{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));const wait=async(f)=>{for(let i=0;i<100;i++){if(f())return;await sleep(60)}throw Error('UI wait timed out')};
    const recorded=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){if(typeof data==='string')recorded.push(data);return send.call(this,data)};
    const c=await import('/src/core/live/client.js');const binding=await import('/src/core/live/local-bindings.js');
    await c.joinRoom({serverUrl:'http://127.0.0.1:19348',name:'Fixture Member',password:'fixture-room'});
    await wait(()=>window.__mp?.live?.identity&&!window.__mp.live.identity.isGuest);await c.sendChat('previous session fixture');await wait(()=>window.__mp.live.chat.some(m=>m.text==='previous session fixture'));await c.leaveRoom();
    const ok=await c.joinRoom({serverUrl:'http://127.0.0.1:19348',name:'Fixture Member',password:'fixture-room'});
    await wait(()=>window.__mp?.live?.identity&&!window.__mp.live.identity.isGuest);await wait(()=>window.__mp.live.chat.some(m=>m.text==='previous session fixture'));const historyPreserved=window.__mp.live.chat.some(m=>m.text==='previous session fixture');const instantClean=!window.__mp.live.sessionChat.some(m=>m.text==='previous session fixture');
    document.querySelector('.titlebar-search').click();await wait(()=>document.querySelector('.palette-input input'));
    const searchInput=document.querySelector('.palette-input input');searchInput.value='Fixture';searchInput.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(()=>document.querySelector('.palette-song'));const overlaySearch=document.querySelector('.palette-song').textContent.includes('Fixture Song');
    document.querySelector('.palette-song button').click();await wait(()=>recorded.some(x=>x.includes('destination:/app/enqueue')));await wait(()=>window.__mp.live.queue.some(x=>x.id==='1000')||window.__mp.live.nowPlaying?.id==='1000');const enqueueUpdated=true;
    searchInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await sleep(200);
    await wait(()=>document.querySelector('#playlist-user-search'));
    const input=document.querySelector('#playlist-user-search');input.value='Alice';input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await wait(()=>document.querySelector('.playlist-user-row button'));document.querySelector('.playlist-user-row button').click();
    await wait(()=>document.querySelector('.playlist-entry'));const stored=binding.readLocalBindings();document.querySelector('.playlist-entry').click();
    await wait(()=>document.querySelectorAll('.playlist-song').length===50);const initial=document.querySelectorAll('.playlist-song').length;
    document.querySelector('.playlist-more').click();await wait(()=>document.querySelectorAll('.playlist-song').length===53);
    const count=document.querySelectorAll('.playlist-song').length;const button=[...document.querySelectorAll('.playlist-track-head button')][0];button.click();
    await wait(()=>document.querySelector('.playlist-notice'));const notice=document.querySelector('.playlist-notice').textContent.trim();
    const sendBind=recorded.some(x=>x.includes('/app/user/bind'));const sentImport=recorded.some(x=>x.includes('/app/enqueue/playlist'));
    const boundBeforeUnbind=stored.netease?.name;document.querySelector('.playlist-bound button').click();await sleep(100);
    const unbound=!binding.readLocalBindings().netease;
    const party=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('派对'));party.click();await sleep(350);
    [...document.querySelectorAll('.side-item')].find(e=>e.textContent.includes('即时聊天')).click();await wait(()=>document.querySelector('.instant-chat'));
    const beforeSystem=!!document.querySelector('.instant-system');const playingBefore=window.__mp.live.playing;window.__mp.live.playing=false;await sleep(150);const pausedUi=document.querySelector('.hero-kicker')?.textContent.includes('已暂停')&&!window.__mp.playback.playing;window.__mp.live.playing=true;await sleep(150);const playingUi=document.querySelector('.hero-kicker')?.textContent.includes('正在播放')&&window.__mp.playback.playing;window.__mp.live.playing=playingBefore;const chat=document.querySelector('.instant-compose input');chat.value='real fixture chat';chat.dispatchEvent(new Event('input',{bubbles:true}));chat.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await wait(()=>document.querySelector('.instant-chat-scroll')?.textContent.includes('real fixture chat'));const liveChatSent=true;
    window.__mp.live.connected=false;chat.value='retain failed draft';chat.dispatchEvent(new Event('input',{bubbles:true}));chat.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await sleep(150);
    const failedDraftRetained=chat.value==='retain failed draft';window.__mp.live.connected=true;chat.value='';chat.dispatchEvent(new Event('input',{bubbles:true}));
    const oldChat=[...window.__mp.live.sessionChat];window.__mp.live.sessionChat=Array.from({length:500},(_,i)=>({id:'cap-'+i,type:'chat',time:'00:00',user:'Fixture',text:'row '+i}));await sleep(150);
    window.__mp.live.sessionChat.shift();window.__mp.live.sessionChat.push({id:'cap-new',type:'chat',time:'00:01',user:'Fixture',text:'newest'});await sleep(150);
    const scroll=document.querySelector('.instant-chat-scroll'),scrollAtCap=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<3;window.__mp.live.sessionChat=oldChat;await sleep(100);
    window.__mp.live.sessionChat.push({id:'old-history',type:'song',time:'00:02',user:'SYSTEM',song:{id:'',title:'/Dream',artist:'历史记录'}});await sleep(100);
    const historyButton=[...document.querySelectorAll('.instant-song button')].find(x=>x.textContent.includes('搜索点歌'));historyButton.click();await wait(()=>document.querySelector('.palette-input input'));const oldSongSearch=document.querySelector('.palette-input input').value==='/Dream'&&!!document.querySelector('.palette-sources');document.querySelector('.palette-input input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await sleep(150);
    document.querySelector('.instant-toggle input').click();await sleep(100);const systemToggled=!!document.querySelector('.instant-system');
    [...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('搜索')).click();await sleep(350);
    const again=document.querySelector('#playlist-user-search');again.value='Alice';again.dispatchEvent(new Event('input',{bubbles:true}));again.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await wait(()=>document.querySelector('.playlist-user-row button'));document.querySelector('.playlist-user-row button').click();await wait(()=>document.querySelector('.playlist-entry'));document.querySelector('.playlist-entry').click();await wait(()=>document.querySelectorAll('.playlist-song').length===50);
    return {ok,pausedUi,playingUi,enqueueUpdated,historyPreserved,instantClean,initial,count,notice,sendBind,sentImport,boundBeforeUnbind,unbound,overlaySearch,beforeSystem,liveChatSent,failedDraftRetained,scrollAtCap,systemToggled,oldSongSearch};
  })()`
  const env = { ...process.env, MP_DEV: '1', MP_SHOT: '1', MP_SHOT_VIEW: 'search', MP_EVAL: code,
    MP_EVAL_WAIT: '2000', MP_SHOT_OUT: path.join(temp, 'playlist-ui.png') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['.'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d)
  const exit = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(-1) }, 60000); child.on('exit', code => { clearTimeout(timer); resolve(code) }) })
  let result
  try { result = JSON.parse(output.match(/\[eval\] result (.*)/)[1]) } catch { throw Error(output.slice(-2500)) }
  const passed = exit === 0 && result.ok && result.pausedUi && result.playingUi && result.enqueueUpdated && result.historyPreserved && result.instantClean && result.initial === 50 && result.count === 53 && result.boundBeforeUnbind === 'Alice Fixture' &&
    result.sentImport && !result.sendBind && result.unbound && result.overlaySearch && !result.beforeSystem && result.liveChatSent && result.failedDraftRetained && result.scrollAtCap && result.systemToggled && result.oldSongSearch && !/失败|错误/.test(result.notice)
  console.log(JSON.stringify({ passed, result, upstream: events.filter(e => e.path === '/playlist/track/all'), screenshot: path.join(temp, 'playlist-ui.png') }))
  if (!passed) process.exitCode = 1
} finally {
  if (vite) await vite.close()
  if (backend) await backend.stop({ graceMs: 0 })
  if (upstream) await new Promise(resolve => upstream.close(resolve))
}

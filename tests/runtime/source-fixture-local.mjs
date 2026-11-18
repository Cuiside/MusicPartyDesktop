import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

// Real desktop + local Java service, with a synthetic music API and temporary data.
const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const java = process.env.MP_TEST_JAVA
const jar = process.env.MP_TEST_JAR
if (!java || !jar) throw new Error('Set MP_TEST_JAVA and MP_TEST_JAR to the test JDK and JAR')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dev-fixture-'))
const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})
const serverPort = await freePort()
const songs = ['1', '2', '3'].map(id => ({ id, name: `Fixture ${id}`, ar: [{ name: 'Fixture' }], dt: 60000, al: { id: 88 } }))
const extraSong = { id: '4', name: 'Fixture 4', ar: [{ name: 'Fixture' }], dt: 60000, al: {} }
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  let body
  if (url.pathname === '/search') body = url.searchParams.get('type') === '1002'
    ? { result: { userprofiles: [{ userId: 42, nickname: 'Fixture User' }] } }
    : { result: { songs } }
  else if (url.pathname === '/user/playlist') body = { code: 200, playlist: [{ id: 99, name: 'Fixture List', trackCount: 3 }], more: false }
  else if (url.pathname === '/playlist/detail') body = { code: 200, playlist: { id: 99, name: 'Fixture List', trackCount: 3 } }
  else if (url.pathname === '/playlist/track/all') body = { code: 200, songs }
  else if (url.pathname === '/album') body = { album: { id: 88, name: 'Fixture Album' }, songs }
  else if (url.pathname === '/song/detail') body = { songs: [...songs, extraSong].filter(song => song.id === url.searchParams.get('ids')) }
  else if (url.pathname === '/song/url/v1' || url.pathname === '/song/url') body = { data: [{ url: 'https://example.com/fixture.mp3', type: 'mp3', time: 15000, freeTrialInfo: { start: 0, end: 15 } }] }
  else if (url.pathname === '/lyric') body = { lrc: { lyric: '[00:00.00]Fixture lyric' } }
  else { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
})
await new Promise((resolve, reject) => api.listen(0, '127.0.0.1', resolve).on('error', reject))
const sourcePort = api.address().port
const server = spawn(java, ['-jar', jar, `--server.port=${serverPort}`, '--server.address=127.0.0.1',
  `--app.music-api.netease.base-url=http://127.0.0.1:${sourcePort}`, '--app.music-api.sources.netease.enabled=true', '--app.music-api.sources.bilibili.enabled=false'],
  { cwd: data, windowsHide: true, stdio: 'ignore', env: { ...process.env, ADMIN_PASSWORD: 'fixture-admin' } })
const vite = await createServer({ root, configFile: path.join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } })
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (server.exitCode != null) throw new Error(`Fixture Java exited: ${server.exitCode}`)
    try { ready = (await fetch(`http://127.0.0.1:${serverPort}/api/auth/status`)).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, 'Fixture service did not become ready')
  assert.equal((await fetch(`http://127.0.0.1:${serverPort}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-room' }) })).status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${serverPort}/api/admin/config/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': 'fixture-admin' }, body: JSON.stringify({ allowSeek: true }) })).status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${serverPort}/api/admin/playlist-claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': 'fixture-admin' }, body: JSON.stringify({ allowPlaylistClaim: true }) })).status, 200)
  await vite.listen()
  const code = `(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const c = await import('/src/core/live/client.js');
    const api = await import('/src/core/live/api.js');
    const t = await import('/src/core/live/transport.js');
    const ok = await c.joinRoom({serverUrl:'http://127.0.0.1:${serverPort}',name:'Fixture User',password:'fixture-room'});
    await wait(1200);
    const found = await c.search('netease','fixture');
    const users = await api.searchUsers('netease','fixture');
    const lists = await api.getUserPlaylists('netease','42');
    const page = await api.getPlaylistSongs('netease','99',0,50,'playlist');
    const album = await api.getSongAlbum('netease','1');
    const albumPage = await api.getPlaylistSongs('netease',album.id,0,50,'album');
    await t.publishCommand(t.DEST.togglePause, {}); await wait(500);
    const imported = await c.importPlaylist('netease','99','playlist');
    await wait(1200);
    const l = window.__mp.live;
    const before = l.queue.map(song => song.queueId);
    const reversed = [...l.queue].reverse();
    const reordered = l.queue.length === 2 ? await c.reorderQueue(reversed, l.queue[1]) : {ok:false};
    await wait(800);
    const orderChanged = before.length===2 && l.queue[0]?.queueId===before[1] && l.queue[1]?.queueId===before[0];
    const modeInput = document.querySelector('.mode-picker');
    if (modeInput) { modeInput.value = 'ROUND_ROBIN'; modeInput.dispatchEvent(new Event('change', {bubbles:true})); }
    const earlySeek = await c.seekRoom(5, l.playbackId); await wait(1300);
    const modeChanged = l.playMode === 'ROUND_ROBIN';
    const seekInput = document.querySelector('.room-seek');
    if (seekInput) { seekInput.dispatchEvent(new Event('focus')); seekInput.value = '5'; seekInput.dispatchEvent(new Event('change', {bubbles:true})); }
    await wait(600);
    const seekProgress = l.progress;
    const preview = { trial: l.nowPlaying?.trial, duration: l.nowPlaying?.duration, full: l.nowPlaying?.fullDuration };
    // Freeze playback while exercising the server's 10-second offline claim window.
    await wait(600); await c.togglePlay(false); await wait(400);
    const peer = new WebSocket('ws://127.0.0.1:${serverPort}/ws');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('peer connect timeout')), 5000);
      peer.onopen = () => peer.send('CONNECT\\naccept-version:1.2\\nhost:localhost\\nroom-password:fixture-room\\nuser-name:Fixture Peer\\nuser-token:fixture-peer-token\\n\\n\\u0000');
      peer.onmessage = event => { if (String(event.data).startsWith('CONNECTED')) { clearTimeout(timeout); resolve(); } };
      peer.onerror = () => { clearTimeout(timeout); reject(new Error('peer failed')); };
    });
    peer.send('SEND\\ndestination:/app/enqueue\\ncontent-type:application/json\\n\\n' + JSON.stringify({platform:'netease',musicId:'4'}) + '\\u0000');
    for (let i=0; i<40 && !l.queue.some(song => song.id === '4'); i++) await wait(100);
    const peerSong = l.queue.find(song => song.id === '4');
    const onlineClaim = await c.claimPlaylist(peerSong);
    peer.close();
    await wait(11500);
    const claim = await c.claimPlaylist(peerSong);
    await wait(800);
    const beforeAlbumTotal = l.queue.length + Number(!!l.nowPlaying);
    const estimator = await import('/src/core/live/import-notice.js');
    const estimated = await estimator.estimateImportDuplicates('netease', album.id, 'album');
    const albumImport = await c.importPlaylist('netease', album.id, 'album');
    await wait(600);
    const state = {ok, search:found.length, users:users.length, lists:lists.length, tracks:page.songs.length, album:album.name, albumTracks:albumPage.songs.length,
      imported:imported.ok, confirmed:imported.confirmed, added:imported.added, queued:l.queue.length,
      current:!!l.nowPlaying, compact:l.compactSync, reorderSent:reordered.ok, orderChanged,
      modeUI:!!modeInput, modeChanged, earlySeekCode:earlySeek.code, seekUI:!!seekInput, progress:seekProgress,
      peerSeen:!!peerSong, onlineClaimCode:onlineClaim.code, claimOk:claim.ok, claimConfirmed:claim.confirmed,
      claimed:claim.claimed, claimedOwner:l.queue.find(song => song.id === '4')?.ownerId === l.identity?.id,
      beforeAlbumTotal, estimated:estimated.map(song => song.id), duplicateCount:albumImport.duplicates, albumImportOk:albumImport.ok, albumImportConfirmed:albumImport.confirmed, preview};
    await c.leaveRoom(); return state;
  })()`
  const env = { ...process.env, MP_DEV: '1', MP_SHOT: '1', MP_SHOT_VIEW: 'party', MP_EVAL: code, MP_EVAL_WAIT: '1500', MP_SHOT_OUT: path.join(data, 'fixture.png') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['.'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  const exit = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(-1) }, 45000); child.on('exit', value => { clearTimeout(timer); resolve(value) }) })
  const prefix = '[eval] result '
  const line = output.split('\n').find(value => value.startsWith(prefix))
  const result = line ? JSON.parse(line.slice(prefix.length)) : { error: output.slice(-1500) }
  console.log(JSON.stringify({ exit, result }))
  assert.equal(exit, 0); assert.equal(result.ok, true); assert.equal(result.compact, true)
  assert.equal(result.search, 3); assert.equal(result.users, 1); assert.equal(result.lists, 1); assert.equal(result.tracks, 3)
  assert.equal(result.album, 'Fixture Album'); assert.equal(result.albumTracks, 3)
  assert.equal(result.imported, true); assert.equal(result.confirmed, true); assert.equal(result.added, 3)
  assert.equal(result.beforeAlbumTotal, 4)
  assert.equal(result.reorderSent, true); assert.equal(result.orderChanged, true)
  assert.equal(result.modeUI, true); assert.equal(result.modeChanged, true)
  assert.equal(result.earlySeekCode, 'COOLDOWN')
  assert.equal(result.seekUI, true); assert.ok(result.progress >= 5 && result.progress < 10)
  assert.equal(result.peerSeen, true); assert.equal(result.onlineClaimCode, 'INVALID')
  assert.equal(result.claimOk, true); assert.equal(result.claimConfirmed, true); assert.equal(result.claimed, 1); assert.equal(result.claimedOwner, true)
  assert.equal(result.albumImportOk, true); assert.equal(result.albumImportConfirmed, true)
  assert.equal(result.estimated.length, 2); assert.equal(result.duplicateCount, 2)
  assert.deepEqual(result.preview, { trial: true, duration: 15, full: 60 })
} finally {
  await vite.close()
  server.kill()
  await new Promise(resolve => api.close(resolve))
}

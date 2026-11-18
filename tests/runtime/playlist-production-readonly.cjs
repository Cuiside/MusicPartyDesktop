'use strict'
// Read-only contract check. Never prints room token, user ID, playlist titles or songs.
const base = 'https://music.example.com'
const password = process.env.MP_DIAG_ROOM
const userId = process.env.MP_DIAG_NETEASE_USER_ID
if (!password || !userId) throw new Error('Set MP_DIAG_ROOM and MP_DIAG_NETEASE_USER_ID')
;(async () => {
  const verified = await fetch(`${base}/api/auth/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password })
  })
  const auth = await verified.json()
  if (!verified.ok || !auth.roomToken) throw new Error(`Room verification failed: ${verified.status}`)
  const headers = { 'X-Room-Token': auth.roomToken }
  const list = await fetch(`${base}/api/user/playlists/netease/${encodeURIComponent(userId)}`, { headers })
  const playlists = await list.json()
  let tracksStatus = null, tracksCount = null
  if (list.ok && Array.isArray(playlists) && playlists[0]?.id) {
    const songs = await fetch(`${base}/api/playlist/songs/netease/${encodeURIComponent(playlists[0].id)}?offset=0&limit=50`, { headers })
    tracksStatus = songs.status
    const data = await songs.json()
    tracksCount = Array.isArray(data) ? data.length : null
  }
  console.log(JSON.stringify({ playlistsStatus: list.status, playlistCount: Array.isArray(playlists) ? playlists.length : null, tracksStatus, tracksCount }))
  if (!list.ok || !Array.isArray(playlists) || !playlists.length || tracksStatus !== 200 || tracksCount == null) process.exitCode = 1
})().catch(error => { console.error(error.message); process.exitCode = 1 })

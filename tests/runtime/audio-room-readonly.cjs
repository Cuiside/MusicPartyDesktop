'use strict'
const { Client } = require('@stomp/stompjs')

;(async () => {
  const password = process.env.MP_DIAG_ROOM
  if (!password) throw new Error('Set MP_DIAG_ROOM')
  let state
  const client = new Client({
    brokerURL: 'wss://music.example.com/ws', reconnectDelay: 0,
    connectHeaders: { 'user-name': '游客音频诊断', 'room-password': password },
    onConnect: () => {
      const consume = message => { state = JSON.parse(message.body) }
      client.subscribe('/app/player/state', consume)
      client.subscribe('/topic/player/state', consume)
      client.publish({ destination: '/app/player/resync', body: '{}' })
    }
  })
  client.activate()
  try {
    for (let i = 0; i < 50 && !state; i++) await new Promise(resolve => setTimeout(resolve, 100))
    const music = state?.nowPlaying?.music
    let audioStatus = null, contentType = null
    if (music?.url && /^https?:/.test(music.url)) {
      try {
        const response = await fetch(music.url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(8000) })
        audioStatus = response.status
        contentType = response.headers.get('content-type')
        await response.body?.cancel()
      } catch { audioStatus = 'network-error' }
    }
    console.log(JSON.stringify({ connected: client.connected, stateReceived: !!state, currentTrack: !!music,
      isPaused: state?.isPaused ?? null, hasAudioUrl: !!music?.url, urlType: music?.urlType ?? null, audioStatus, contentType }))
  } finally { await client.deactivate() }
})().catch(error => { console.error(error.message); process.exitCode = 1 })

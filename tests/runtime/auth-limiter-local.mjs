import assert from 'node:assert/strict'
import { Client } from '@stomp/stompjs'

// This intentionally exhausts the room authentication budget. Use only the
// disposable local server on the dedicated integration-test port.
const base = 'http://127.0.0.1:18993'
const attempt = async password => fetch(`${base}/api/auth/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
})
const stompAttempt = password => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { void client.deactivate({ force: true }); reject(new Error('STOMP error timeout')) }, 5000)
  const client = new Client({ brokerURL: 'ws://127.0.0.1:18993/ws', reconnectDelay: 0,
    connectHeaders: { 'room-password': password },
    onConnect: () => { clearTimeout(timer); void client.deactivate(); reject(new Error('invalid password was accepted')) },
    onStompError: frame => { clearTimeout(timer); void client.deactivate({ force: true }); resolve(`${frame.headers?.message || ''} ${frame.body || ''}`) },
    onWebSocketError: () => {}
  })
  client.activate()
})

for (let i = 0; i < 4; i++) assert.equal((await attempt('incorrect')).status, 401)
assert.match(await stompAttempt('incorrect'), /INVALID_ROOM_PASSWORD/)
assert.equal((await attempt('incorrect')).status, 429)
assert.match(await stompAttempt('incorrect'), /RATE_LIMITED/)
console.log('PASS: HTTP and STOMP share the same authentication budget and return identifiable ERROR frames')

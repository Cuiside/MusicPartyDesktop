import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldNotifyChat } from '../../src/core/live/chat-notification.js'

test('only new live messages from other users notify', () => {
  const base = { raw:{ type:'CHAT', userId:'peer', userName:'Peer' }, mapped:{ me:false }, history:false, existing:false, currentName:'Me', identityKnown:true }
  assert.equal(shouldNotifyChat(base), true)
  for (const type of ['SYSTEM','LIKE','PLAY_START','']) assert.equal(shouldNotifyChat({ ...base, raw:{...base.raw,type} }), false)
  assert.equal(shouldNotifyChat({ ...base, history:true }), false)
  assert.equal(shouldNotifyChat({ ...base, existing:true }), false)
  assert.equal(shouldNotifyChat({ ...base, mapped:{me:true} }), false)
  assert.equal(shouldNotifyChat({ ...base, raw:{type:'CHAT', userName:'Me'} }), false)
  assert.equal(shouldNotifyChat({ ...base, raw:{type:'CHAT', userId:'self', userName:'Me'}, identityKnown:false }), false)
  assert.equal(shouldNotifyChat({ ...base, raw:{type:'CHAT', userId:'self'}, currentName:undefined, identityKnown:false }), false)
  assert.equal(shouldNotifyChat({ ...base, raw:{type:'CHAT', userId:'peer', userName:'Me'}, identityKnown:true }), true)
})

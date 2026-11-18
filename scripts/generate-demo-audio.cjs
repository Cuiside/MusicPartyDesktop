'use strict'
// Original deterministic synthetic test tones: no samples, external recordings or melodies.
const fs = require('node:fs'), path = require('node:path')
const dir = path.join(__dirname, '..', 'public', 'demo-audio')
fs.mkdirSync(dir, { recursive: true })
const rate = 16000, seconds = 8, count = rate * seconds
for (let track = 1; track <= 15; track++) {
  const wav = Buffer.alloc(44 + count * 2)
  wav.write('RIFF',0); wav.writeUInt32LE(36 + count * 2,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16)
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28)
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(count*2,40)
  for (let i = 0; i < count; i++) {
    const t = i / rate, segment = Math.floor(t * 2), phase = t * 2 - segment
    const note = 220 * 2 ** (((track * 7 + segment * (track % 5 + 3)) % 19) / 12)
    const envelope = Math.min(1, phase * 12) * Math.min(1, (1 - phase) * 6) * Math.min(1, t * 2) * Math.min(1, (seconds - t) * 2)
    const sample = (Math.sin(2*Math.PI*note*t) * 0.21 + Math.sin(2*Math.PI*note*2*t) * 0.04) * envelope
    wav.writeInt16LE(Math.round(sample * 32767),44+i*2)
  }
  fs.writeFileSync(path.join(dir, `test-${String(track).padStart(2,'0')}.wav`), wav)
}
console.log(`Generated 15 original synthetic test clips in ${dir}`)

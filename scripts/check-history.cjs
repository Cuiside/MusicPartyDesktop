#!/usr/bin/env node
'use strict'

// Scan reachable Git objects without logging their contents or matching values.
// This is a limited preflight; compressed archives and binary objects require separate review.
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const ref = process.argv[2] || 'HEAD'
if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-')) throw new Error('Invalid Git ref')
const objects = execFileSync('git', ['rev-list', '--objects', ref], { cwd: root, maxBuffer: 128 * 1024 * 1024 })
  .toString('utf8').split('\n').map(line => line.slice(0, 40)).filter(id => /^[a-f0-9]{40}$/.test(id))
const input = Buffer.from([...new Set(objects)].join('\n') + '\n')
const output = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input, maxBuffer: 512 * 1024 * 1024 })
const patterns = [
  ['private key material', /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/],
  ['access token', /\b(?:ghp|github_pat|gho)_[A-Za-z0-9_]{30,}\b/],
  ['cookie-like credential', /(?:MUSIC_U|SESSDATA)=[A-Za-z0-9_%]{35,}/i],
  ['personal profile path', /[A-Za-z]:[\\/]+Users[\\/]+(?!me[\\/]|example[\\/])[^\\/\s"']+[\\/]+/i]
]
let position = 0, texts = 0, skipped = 0, matches = 0
while (position < output.length) {
  const end = output.indexOf(10, position)
  if (end < 0) throw new Error('Invalid Git object stream')
  const header = output.subarray(position, end).toString('ascii').split(' ')
  const size = Number(header[2])
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git object size')
  const data = output.subarray(end + 1, end + 1 + size)
  position = end + size + 2
  if (header[1] !== 'blob') continue
  if (size > 10 * 1024 * 1024 || data.includes(0)) { skipped++; continue }
  texts++
  const text = data.toString('utf8')
  for (const [label, pattern] of patterns) if (pattern.test(text)) { matches++; console.error(`${header[0].slice(0, 12)}: ${label}`) }
}
console.log(`History preflight: ${texts} text blobs, ${skipped} binary/large blobs need separate review, ${matches} matches`)
if (!texts || matches) process.exitCode = 1

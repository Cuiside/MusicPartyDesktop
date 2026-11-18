#!/usr/bin/env node
'use strict'

// Limited package preflight; prints paths and categories, never matched values.
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const target = process.argv[2]
if (!target || !fs.existsSync(target)) throw new Error('Pass the path to app.asar')
const rules = [
  ['private key material', /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/],
  ['access token', /\b(?:ghp|github_pat|gho)_[A-Za-z0-9_]{30,}\b/],
  ['cookie-like credential', /(?:MUSIC_U|SESSDATA)=[A-Za-z0-9_%]{35,}/i],
  ['personal profile path', /[A-Za-z]:[\\/]+Users[\\/]+(?!me[\\/]|example[\\/])[^\\/\s"']+[\\/]+/i],
  ['local project path', /[A-Za-z]:[\\/]+MusicParty(?:Desktop|Delivery|ServerFix|PR)[\\/]+/i]
]
let scanned = 0, skipped = 0, matches = 0
for (const item of asar.listPackage(target)) {
  const name = item.replace(/^[/\\]+/, '')
  let info
  try { info = asar.statFile(target, name) } catch { continue }
  if (info.files || info.link || !Number.isFinite(info.size)) continue
  if (info.size > 10 * 1024 * 1024) { skipped++; continue }
  let data
  try { data = asar.extractFile(target, name) } catch { skipped++; continue }
  if (data.includes(0)) { skipped++; continue }
  scanned++
  const text = data.toString('utf8')
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) { console.error(`${name}: ${label}`); matches++ }
  }
}
console.log(`ASAR preflight: ${scanned} text files, ${skipped} binary/large files need separate review, ${matches} matches`)
if (!scanned || matches) process.exitCode = 1

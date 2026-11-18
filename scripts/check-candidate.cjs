#!/usr/bin/env node
'use strict'

// Scan tracked and non-ignored candidate files without printing matching values.
// This is a limited preflight, not a substitute for history and package inspection.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean))]
const rules = [
  { label: 'private key material', re: /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/ },
  { label: 'access token', re: /\b(?:ghp|github_pat|gho)_[A-Za-z0-9_]{30,}\b/ },
  { label: 'cookie-like credential', re: /(?:MUSIC_U|SESSDATA)=[A-Za-z0-9_%]{35,}/i },
  { label: 'personal profile path', re: /[A-Za-z]:[\\/]+Users[\\/]+(?!me[\\/]|example[\\/])[^\\/\s"']+[\\/]+/i },
  { label: 'local project path', re: /[A-Za-z]:[\\/]+MusicParty(?:Desktop|Delivery|ServerFix|PR)[\\/]+/i }
]
const ignore = new Set(['scripts/check-candidate.cjs'])
const findings = []
let scanned = 0, binaries = 0
for (const name of files) {
  if (ignore.has(name)) continue
  const full = path.join(root, name)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue
  const data = fs.readFileSync(full)
  if (data.includes(0) || data.length > 10 * 1024 * 1024) { binaries++; continue }
  scanned++
  const text = data.toString('utf8')
  for (const rule of rules) if (rule.re.test(text)) findings.push({ file: name, rule: rule.label })
}
for (const finding of findings) console.error(`${finding.file}: ${finding.rule}`)
console.log(`Candidate preflight: ${scanned} text files, ${binaries} binary/large files need separate review, ${findings.length} matches`)
if (findings.length || !scanned) process.exitCode = 1

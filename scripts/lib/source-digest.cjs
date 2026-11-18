'use strict'

// Fingerprint tracked and non-ignored source files, including uncommitted changes.
// The file contents and paths are never printed; only the digest leaves this process.
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sourceDigest(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  const paths = [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort()
  const hash = crypto.createHash('sha256')
  for (const name of paths) {
    const file = path.join(root, name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) throw new Error(`Source entry is not a regular file: ${name}`)
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    hash.update(`${Buffer.byteLength(name)}:${name}:${stat.size}:${digest}\n`)
  }
  return hash.digest('hex').toUpperCase()
}

module.exports = { sourceDigest }
if (require.main === module) console.log(sourceDigest(path.resolve(__dirname, '../..')))

/** One-off maintenance: migrate suites to the PORT_BASE-aware env exports. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const suitesDir = path.resolve(HERE, '..', 'suites')

for (const name of fs.readdirSync(suitesDir)) {
  if (!name.endsWith('.mjs') || name === 'desktop-pure.mjs') continue
  const file = path.join(suitesDir, name)
  let text = fs.readFileSync(file, 'utf8')
  const before = text
  text = text.replace(/^const PORT = 18848\r?\n/m, '')
  text = text.replace(/^const UPSTREAM_PORT = 18849\r?\n/m, '')
  // Extend the env import with the port constants (always present in these suites).
  text = text.replace(
    /import \{([^}]*)\} from '\.\.\/lib\/env\.mjs'/,
    (match, names) => {
      const list = names
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      if (!list.includes('DEFAULT_SERVER_PORT as PORT')) list.push('DEFAULT_SERVER_PORT as PORT')
      if (!list.includes('UPSTREAM_PORT')) list.push('UPSTREAM_PORT')
      return `import { ${list.join(', ')} } from '../lib/env.mjs'`
    }
  )
  if (text === before) {
    console.log(`[skip] ${name} (no change)`)
  } else {
    fs.writeFileSync(file, text)
    console.log(`[patched] ${name}`)
  }
}

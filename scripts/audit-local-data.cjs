'use strict'
/**
 * task-11 / local residue audit (READ-ONLY).
 *
 * Scans the desktop app's Electron profile under %APPDATA% (known app-name variants)
 * and the screenshot/eval temp profiles under %TEMP%\mp-shot-*.
 *
 * What it reports:
 *   - directories that exist, with file counts and total sizes (top entries + known files)
 *   - app localStorage keys found in the LevelDB log/data files
 *       mp.desktop.settings / mp.desktop.token / mp.desktop.tutorial.v1 / mp.room.mine.v1
 *   - presence (NOT value) of sensitive fields such as serverUrl / neteaseCookie / password
 *     and a REDACTED match count for the configured server host
 *   - %TEMP%\mp-shot-<pid> leftovers: count, size, age range
 *
 * It never modifies or deletes anything. Output:
 *   stdout summary + screenshots/audit/local-data-audit.json
 *
 * Usage:
 *   node scripts/audit-local-data.cjs
 *   node scripts/audit-local-data.cjs --appdata "C:\\Users\\me\\AppData\\Roaming"
 *   node scripts/audit-local-data.cjs --no-json
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_JSON = path.join(ROOT, 'screenshots', 'audit', 'local-data-audit.json')

const APP_DIR_NAMES = [
  'music-party-desktop',
  'Music Party',
  'MusicParty',
  'MusicPartyDesktop',
  'com.musicparty.desktop'
]

const KNOWN_KEYS = [
  'mp.desktop.settings',
  'mp.desktop.token',
  'mp.desktop.tutorial.v1',
  'mp.room.mine.v1'
]

const SENSITIVE_MARKERS = [
  { id: 'mp.desktop.settings', label: '桌面设置（serverUrl/昵称/模式）' },
  { id: 'mp.desktop.token', label: 'STOMP 用户身份 token（非凭据，但可关联会话身份）' },
  { id: 'mp.desktop.tutorial.v1', label: '新手引导完成标记' },
  { id: 'mp.room.mine.v1', label: '「我的房间」服务器地址' },
  { id: 'neteaseCookie', label: '网易云 Cookie（敏感，仅报告存在）' },
  { id: 'bilibiliCookie', label: 'B站 Cookie（敏感，仅报告存在）' },
  { id: 'adminPassword', label: '管理员密码字段（敏感，仅报告存在）' },
  { id: 'launcher.json', label: '本地启动器配置文件名' }
]

const MIN_FILE = 1
const MAX_READ = 24 * 1024 * 1024 // per file cap for marker search
const MAX_TOTAL_READ = 250 * 1024 * 1024

function bytes(n) {
  if (!Number.isFinite(n)) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function walk(dir, opts = {}, acc = null) {
  const out = acc || { root: dir, files: [], dirs: [], totalBytes: 0, fileCount: 0, errors: [] }
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    out.errors.push({ dir, error: String(error.message || error) })
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (entry.isDirectory()) {
      out.dirs.push({ path: full, mtime: stat.mtimeMs })
      walk(full, opts, out)
    } else if (entry.isFile()) {
      out.files.push({ path: full, size: stat.size, mtime: stat.mtimeMs })
      out.totalBytes += stat.size
      out.fileCount += 1
    }
  }
  return out
}

function findMarkers(buffer) {
  const hits = new Map()
  const add = (id, count) => {
    if (!count) return
    hits.set(id, (hits.get(id) || 0) + count)
  }
  for (const marker of SENSITIVE_MARKERS) {
    const utf8 = Buffer.from(marker.id, 'utf8')
    const utf16 = Buffer.from(marker.id, 'utf16le')
    let count = 0
    count += countOccurrences(buffer, utf8)
    count += countOccurrences(buffer, utf16)
    add(marker.id, count)
  }
  // Redacted server-URL evidence: count http(s):// occurrences but never store the value.
  // LevelDB keeps strings as UTF-8; Chromium may also write UTF-16LE copies.
  const urlRe = /https?:\/\/[^\s"'\\\u0000<>\uFFFD]{4,200}/g
  const latin = buffer.toString('latin1')
  const utf16 = buffer.toString('utf16le')
  const urlMatches = (latin.match(urlRe) || []).length + (utf16.match(urlRe) || []).length
  add('__httpUrlOccurrences', urlMatches)
  // Known-host marker without printing the host: count generic host prefixes only.
  for (const probe of ['music.', '127.0.0.1', 'localhost']) {
    add('__probe:' + probe, countOccurrences(buffer, Buffer.from(probe, 'utf8')) + countOccurrences(buffer, Buffer.from(probe, 'utf16le')))
  }
  return hits
}

function countOccurrences(buffer, needle) {
  if (!needle.length) return 0
  let count = 0
  let index = buffer.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = buffer.indexOf(needle, index + needle.length)
  }
  return count
}

function scanProfile(textRoot, appDataRoot) {
  const dir = path.join(appDataRoot, textRoot)
  const report = { name: textRoot, dir, exists: false }
  try {
    report.exists = fs.statSync(dir).isDirectory()
  } catch {
    return report
  }
  const tree = walk(dir)
  report.totalBytes = tree.totalBytes
  report.fileCount = tree.fileCount
  report.totalBytesText = bytes(tree.totalBytes)
  report.topDirs = tree.dirs
    .map((d) => {
      const sub = walk(d.path)
      return { name: path.relative(dir, d.path), files: sub.fileCount, bytes: sub.totalBytes, bytesText: bytes(sub.totalBytes) }
    })
    .filter((d) => d.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 12)
  report.knownFiles = tree.files
    .filter((f) => /launcher\.json|Preferences|Local State|Cookies|Login Data|000003\.log|MANIFEST-|\.ldb$/i.test(f.path))
    .map((f) => ({ name: path.relative(dir, f.path), size: f.size, bytesText: bytes(f.size), mtime: new Date(f.mtime).toISOString() }))

  // Marker search across the profile: only files that commonly contain storage strings.
  const interesting = tree.files.filter((f) => {
    const rel = path.relative(dir, f.path).toLowerCase()
    if (/\\cache\\|\\code cache\\|gpucache|dawncache|blob_storage/.test('\\' + rel)) return false
    if (f.size < MIN_FILE || f.size > MAX_READ) return false
    return /local storage|session storage|leveldb|launcher\.json|preferences|local state/i.test(rel)
  })
  report.scannedFiles = []
  const keyHits = new Map()
  const probeHits = new Map()
  let readTotal = 0
  for (const file of interesting) {
    if (readTotal > MAX_TOTAL_READ) break
    let buffer
    try {
      buffer = fs.readFileSync(file.path)
    } catch {
      continue
    }
    readTotal += buffer.length
    const hits = findMarkers(buffer)
    const keys = []
    for (const [id, count] of hits) {
      if (id.startsWith('__probe:')) {
        const probe = id.slice('__probe:'.length)
        probeHits.set(probe, (probeHits.get(probe) || 0) + count)
      } else if (id === '__httpUrlOccurrences') {
        probeHits.set('__httpUrlOccurrences', (probeHits.get('__httpUrlOccurrences') || 0) + count)
      } else {
        keyHits.set(id, (keyHits.get(id) || 0) + count)
        keys.push({ id, count })
      }
    }
    if (keys.length) report.scannedFiles.push({ name: path.relative(dir, file.path), size: file.size, keys })
  }
  report.localStorageKeys = KNOWN_KEYS.filter((k) => keyHits.has(k)).map((k) => ({
    key: k,
    matches: keyHits.get(k),
    label: SENSITIVE_MARKERS.find((m) => m.id === k)?.label || ''
  }))
  report.otherSensitiveFields = SENSITIVE_MARKERS.filter(
    (m) => !KNOWN_KEYS.includes(m.id) && keyHits.has(m.id) && m.id !== 'launcher.json'
  ).map((m) => ({ field: m.id, label: m.label, matches: keyHits.get(m.id) }))
  report.launcherJsonPresent = fs.existsSync(path.join(dir, 'launcher.json'))
  report.serverMarkerCounts = {
    redactedHttpUrlOccurrences: probeHits.get('__httpUrlOccurrences') || 0,
    'probe:music.': probeHits.get('music.') || 0,
    'probe:127.0.0.1': probeHits.get('127.0.0.1') || 0,
    'probe:localhost': probeHits.get('localhost') || 0
  }
  report.note = '服务器 URL / Cookie / 密码的值一律不落盘、不回显；仅记录键名、匹配次数与是否命中。'
  return report
}

function scanTempProfiles() {
  const tmp = os.tmpdir()
  let entries
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true })
  } catch (error) {
    return { dir: tmp, count: 0, totalBytes: 0, errors: [String(error)] }
  }
  const matches = entries.filter((e) => e.isDirectory() && /^mp-shot-\d+$/.test(e.name))
  const rows = []
  let totalBytes = 0
  for (const entry of matches) {
    const full = path.join(tmp, entry.name)
    const tree = walk(full)
    totalBytes += tree.totalBytes
    const stat = fs.statSync(full)
    rows.push({
      name: entry.name,
      path: full,
      files: tree.fileCount,
      bytes: tree.totalBytes,
      bytesText: bytes(tree.totalBytes),
      created: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
      modified: new Date(stat.mtimeMs).toISOString()
    })
  }
  rows.sort((a, b) => b.modified.localeCompare(a.modified))
  return {
    dir: tmp,
    count: rows.length,
    totalBytes,
    totalBytesText: bytes(totalBytes),
    newest: rows[0] || null,
    oldest: rows[rows.length - 1] || null,
    samples: rows.slice(0, 10)
  }
}

function main() {
  const appIdx = process.argv.indexOf('--appdata')
  const appDataRoot = appIdx >= 0 ? path.resolve(process.argv[appIdx + 1]) : process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const noJson = process.argv.includes('--no-json')

  const report = {
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    platform: process.platform,
    appDataRoot,
    tempDir: os.tmpdir(),
    profiles: [],
    tempProfiles: null,
    summary: {}
  }

  for (const name of APP_DIR_NAMES) report.profiles.push(scanProfile(name, appDataRoot))
  report.tempProfiles = scanTempProfiles()

  const existing = report.profiles.filter((p) => p.exists)
  const keyProfile = existing.find((p) => p.localStorageKeys.length > 0) || existing[0] || null
  report.summary = {
    profilesFound: existing.map((p) => ({ name: p.name, dir: p.dir, bytesText: p.totalBytesText, files: p.fileCount })),
    localStorageKeysFound: keyProfile ? keyProfile.localStorageKeys.map((k) => k.key) : [],
    sensitiveFieldsFound: keyProfile ? keyProfile.otherSensitiveFields.map((f) => f.field) : [],
    launcherJsonPresent: Boolean(keyProfile && keyProfile.launcherJsonPresent),
    tempProfileCount: report.tempProfiles.count,
    tempProfileBytesText: report.tempProfiles.totalBytesText,
    serverMarkerCounts: keyProfile ? keyProfile.serverMarkerCounts : null
  }

  /* ---------------- human readable output ---------------- */
  const lines = []
  const add = (s = '') => lines.push(s)
  add('='.repeat(78))
  add('MusicParty 桌面端 · 本地残留数据审计（只读，不删除任何文件）')
  add('='.repeat(78))
  add(`生成时间     : ${report.generatedAt}`)
  add(`APPDATA 根   : ${appDataRoot}`)
  add(`TEMP 根      : ${os.tmpdir()}`)
  add('')
  add(`[1] 应用 profile（${existing.length} 个存在）`)
  for (const p of report.profiles) {
    if (!p.exists) {
      add(`  - ${p.name.padEnd(26)} 不存在`)
      continue
    }
    add(`  - ${p.name.padEnd(26)} ${p.totalBytesText.padStart(9)} · ${p.fileCount} 个文件 · ${p.dir}`)
    if (p.localStorageKeys.length) {
      for (const k of p.localStorageKeys) add(`      localStorage: ${k.key}  (${k.matches} 次匹配) — ${k.label}`)
    }
    for (const f of p.otherSensitiveFields) add(`      敏感字段: ${f.field} — ${f.label}（仅报告存在）`)
    if (p.launcherJsonPresent) add('      发现 launcher.json（本地启动器配置，含路径/Cookie 字段，值未读取回显）')
    if (p.serverMarkerCounts && (p.serverMarkerCounts['probe:music.'] || p.serverMarkerCounts.redactedHttpUrlOccurrences)) {
      add(
        `      服务器痕迹（值已脱敏）: http(s) URL×${p.serverMarkerCounts.redactedHttpUrlOccurrences}` +
          `, music.×${p.serverMarkerCounts['probe:music.']}` +
          `, 127.0.0.1×${p.serverMarkerCounts['probe:127.0.0.1']}`
      )
    }
    if (p.topDirs.length) {
      add('      目录体积 Top:')
      for (const d of p.topDirs.slice(0, 6)) add(`        - ${d.name.padEnd(34)} ${d.bytesText.padStart(9)} (${d.files} files)`)
    }
    if (p.scannedFiles.length) {
      add('      命中文件（键名/字段名，值未落盘）:')
      for (const f of p.scannedFiles.slice(0, 8)) add(`        - ${f.name} [${f.keys.map((k) => k.id + '×' + k.count).join(', ')}]`)
    }
  }
  add('')
  add('[2] %TEMP%\\mp-shot-* 截图/评测临时 profile')
  add(`  数量: ${report.tempProfiles.count} · 合计: ${report.tempProfiles.totalBytesText}`)
  if (report.tempProfiles.newest) add(`  最新: ${report.tempProfiles.newest.name} · ${report.tempProfiles.newest.modified}`)
  if (report.tempProfiles.oldest) add(`  最旧: ${report.tempProfiles.oldest.name} · ${report.tempProfiles.oldest.modified}`)
  for (const row of (report.tempProfiles.samples || []).slice(0, 6)) {
    add(`    - ${row.name.padEnd(22)} ${row.bytesText.padStart(9)} ${row.modified}`)
  }
  add('')
  add('[3] 说明')
  add('  * 本地存储键/值由应用与自动化测试写入；token 是 STOMP 身份（非密码），')
  add('    serverUrl 可能包含自建/朋友服务器地址；Cookie/密码字段只报告存在，不回显。')
  add('  * 清理建议、风险与 UI 入口见 docs/LOCAL_DATA_AUDIT.md；')
  add('    清理脚本为 scripts/clean-local-residue.cjs（默认 dry-run）。')
  add('='.repeat(78))
  const text = lines.join('\n')
  console.log(text)

  if (!noJson) {
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
    fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8')
    console.log(`\n[json] ${OUT_JSON}`)
  }
}

main()

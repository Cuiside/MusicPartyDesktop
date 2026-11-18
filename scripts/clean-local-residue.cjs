'use strict'
/**
 * task-11 / local residue cleanup (DRY-RUN BY DEFAULT).
 *
 * Safe-by-default cleanup for data left behind by the desktop app and by the
 * screenshot/eval harness:
 *
 *   1. %TEMP%\mp-shot-<pid>  — per-run Chromium profiles created by
 *      electron/main.cjs when MP_SHOT / MP_EVAL is set. Always safe to delete.
 *   2. (optional, explicit)  %APPDATA%\music-party-desktop\Local Storage — clears the
 *      app's localStorage keys: mp.desktop.settings, mp.desktop.token,
 *      mp.desktop.tutorial.v1, mp.room.mine.v1. This resets the saved server address,
 *      nickname, tour flag and STOMP identity. Requires --purge-local-storage --yes.
 *
 * It never touches any other directory, never deletes the app profile root, and
 * refuses paths that do not match the expected names.
 *
 * Usage:
 *   node scripts/clean-local-residue.cjs                      # dry-run, report only
 *   node scripts/clean-local-residue.cjs --dry-run            # same
 *   node scripts/clean-local-residue.cjs --apply              # delete mp-shot-* dirs
 *   node scripts/clean-local-residue.cjs --apply --purge-local-storage --yes
 *   node scripts/clean-local-residue.cjs --min-age-minutes 60 # only old temp profiles
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_DIR_NAMES = ['music-party-desktop', 'Music Party', 'MusicParty', 'MusicPartyDesktop']
const KNOWN_KEYS = ['mp.desktop.settings', 'mp.desktop.token', 'mp.desktop.tutorial.v1', 'mp.room.mine.v1']

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function walkSize(dir) {
  const out = { bytes: 0, files: 0, dirs: 0, errors: [] }
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    out.errors.push(String(error.message || error))
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        out.dirs += 1
        const sub = walkSize(full)
        out.bytes += sub.bytes
        out.files += sub.files
        out.dirs += sub.dirs
        out.errors.push(...sub.errors)
      } else if (entry.isFile()) {
        out.files += 1
        out.bytes += fs.statSync(full).size
      }
    } catch {
      /* ignore */
    }
  }
  return out
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 })
    return true
  } catch (error) {
    console.error(`[clean] 删除失败: ${dir} — ${String(error.message || error)}`)
    return false
  }
}

function isUnder(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const dryRun = !apply || args.includes('--dry-run')
  const tempOnly = args.includes('--temp-only')
  const purgeLocal = args.includes('--purge-local-storage') || args.includes('--keys')
  const yes = args.includes('--yes') || args.includes('-y')
  const ageIdx = args.indexOf('--min-age-minutes')
  const minAgeMinutes = ageIdx >= 0 ? Math.max(0, Number(args[ageIdx + 1]) || 0) : 10
  const appIdx = args.indexOf('--appdata')
  const appDataRoot = appIdx >= 0 ? path.resolve(args[appIdx + 1]) : process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')

  const tmp = os.tmpdir()
  const now = Date.now()
  const actions = []

  /* ---------------- 1) temp profiles ---------------- */
  let entries = []
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true })
  } catch (error) {
    console.error(`[clean] 无法读取 TEMP: ${String(error.message || error)}`)
    process.exit(1)
  }
  const candidates = entries.filter((e) => e.isDirectory() && /^mp-shot-\d+$/.test(e.name))
  for (const entry of candidates) {
    const full = path.join(tmp, entry.name)
    if (!isUnder(full, tmp)) continue
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    const ageMinutes = (now - stat.mtimeMs) / 60000
    const size = walkSize(full)
    actions.push({
      kind: 'temp-profile',
      path: full,
      size: size.bytes,
      files: size.files,
      ageMinutes: Math.round(ageMinutes),
      eligible: ageMinutes >= minAgeMinutes,
      reason: ageMinutes >= minAgeMinutes ? '过期截图/评测临时 profile' : `仍在 ${minAgeMinutes} 分钟内，跳过（可能正在运行）`
    })
  }

  /* ---------------- 2) app localStorage dir ---------------- */
  const localTargets = []
  if (purgeLocal) {
    for (const name of APP_DIR_NAMES) {
      const storage = path.join(appDataRoot, name, 'Local Storage')
      try {
        if (fs.statSync(storage).isDirectory()) {
          const size = walkSize(storage)
          localTargets.push({ kind: 'app-local-storage', path: storage, size: size.bytes, files: size.files })
        }
      } catch {
        /* not present */
      }
    }
  }

  /* ---------------- report / apply ---------------- */
  const tempEligible = actions.filter((a) => a.eligible)
  const tempBytes = tempEligible.reduce((n, a) => n + a.size, 0)
  const localBytes = localTargets.reduce((n, a) => n + a.size, 0)

  console.log('='.repeat(78))
  console.log(`MusicParty 本地残留清理  ${dryRun ? '【DRY-RUN 只预览】' : '【APPLY 执行】'}`)
  console.log('='.repeat(78))
  console.log(`TEMP 根            : ${tmp}`)
  console.log(`mp-shot-* 目录     : ${actions.length} 个（可清理 ${tempEligible.length} 个，${bytes(tempBytes)}）`)
  console.log(`最小保留时长       : ${minAgeMinutes} 分钟`)
  if (!tempOnly) {
    console.log(`APPDATA 根         : ${appDataRoot}`)
    if (purgeLocal) {
      console.log(`Local Storage 目标 : ${localTargets.length} 个（${bytes(localBytes)}）`)
      for (const t of localTargets) {
        console.log(`  - ${t.path}`)
        console.log(`    将清除 localStorage 键: ${KNOWN_KEYS.join(', ')}`)
      }
    } else {
      console.log('Local Storage      : 未启用（如需清理加 --purge-local-storage --yes）')
    }
  }
  console.log('')
  console.log('[计划]')
  if (!actions.length) console.log('  （没有 mp-shot-* 临时目录）')
  for (const action of actions) {
    console.log(
      `  ${action.eligible ? 'DELETE ' : 'SKIP   '} ${action.path}  ${bytes(action.size)} (${action.files} files, ${action.ageMinutes}min) — ${action.reason}`
    )
  }
  for (const target of localTargets) {
    console.log(`  ${apply && yes ? 'DELETE ' : 'PLAN   '} ${target.path}  ${bytes(target.size)} — 清除 app localStorage（服务器地址/昵称/引导/身份 token 将重置）`)
  }

  if (!apply) {
    console.log('')
    console.log('[dry-run] 未删除任何文件。确认后执行:')
    console.log('  node scripts/clean-local-residue.cjs --apply')
    if (purgeLocal) console.log('  （含 localStorage）node scripts/clean-local-residue.cjs --apply --purge-local-storage --yes')
    console.log('='.repeat(78))
    process.exit(0)
  }

  if (purgeLocal && !yes) {
    console.error('\n[clean] 拒绝: --purge-local-storage 会清空应用本地存储（服务器地址/昵称/教程记忆/身份 token），必须显式加 --yes。')
    process.exit(2)
  }

  let deleted = 0
  let freed = 0
  for (const action of tempEligible) {
    if (rmrf(action.path)) {
      deleted += 1
      freed += action.size
      console.log(`  deleted ${action.path} (${bytes(action.size)})`)
    }
  }
  if (purgeLocal && yes) {
    for (const target of localTargets) {
      if (rmrf(target.path)) {
        deleted += 1
        freed += target.size
        console.log(`  cleared ${target.path} (${bytes(target.size)})`)
      }
    }
  }
  console.log('')
  console.log(`[apply] 完成: 删除 ${deleted} 项，释放 ${bytes(freed)}`)
  console.log('  提示: localStorage 清理后首次启动会回到全新状态（我的房间地址/昵称/引导标记丢失）。')
  console.log('='.repeat(78))
}

main()

#!/usr/bin/env node
'use strict'

/**
 * 公开发布门禁：禁止把开发者本地信息打进客户端。
 *
 * 用法：
 *   node scripts/check-public-release.cjs          # 检查源码/文档（--src 同义）
 *   node scripts/check-public-release.cjs --dist   # 检查构建产物（构建后/打包前）
 *
 * 注意（D-05）：`npm run build` 只执行 vite build，**不含**本门禁；
 * 门禁由 `scripts/pack.cjs`（pack/pack:dir 等发布命令）在构建前后各调用一次，
 * 命中任何一条规则即 exit 1，阻止打包。
 *
 * 此检查仅覆盖少量常见秘密与本机路径模式，不代表完整安全扫描。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const mode = process.argv.includes('--dist') ? 'dist' : 'src'

// Never store private addresses, passwords or tokens in scanner rules or logs.
const PATTERNS = [
  { label: 'private key', re: /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/ },
  { label: 'credential-like value', re: /(?:MUSIC_U|SESSDATA)=[A-Za-z0-9_%]{30,}/i },
  { label: 'user profile path', re: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+\\{1,2}(?:Documents|Desktop|Downloads|AppData|\.codex)/i }
]
// 注意：不要把 dist 排除在 EXCLUDE 之外的模式里——--dist 必须真的扫描 dist。
// 排除项只针对依赖/缓存/私有目录；扫描根目录已决定范围（src 模式不含 dist）。
const EXCLUDE = /(^|[\\/])(node_modules|\.git|\.tmp-|release|screenshots)([\\/]|$)/i
const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.vue', '.css', '.html', '.htm',
  '.json', '.md', '.yml', '.yaml', '.txt', '.xml', '.svg'
])

// 只扫描“会进入客户端”的目录/文件；scripts 是构建工具与测试断言，docs 是内部文档
// （内部审计报告可能引用历史问题原文，发布仓库前单独人工脱敏）。
const roots = mode === 'dist' ? ['dist'] : ['src', 'electron', 'build', 'README.md']

/** @type {{file: string, line: number, label: string, text: string}[]} */
const hits = []
let scanned = 0

function scanFile(file) {
  if (EXCLUDE.test(file)) return
  // 门禁脚本自身包含规则文本，跳过自己
  if (path.basename(file) === 'check-public-release.cjs') return
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) return
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  scanned += 1
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(lines[i])) {
        hits.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          label: pattern.label,
          text: ''
        })
        break
      }
    }
  }
}

function walk(target) {
  const abs = path.join(ROOT, target)
  if (!fs.existsSync(abs)) return
  const stat = fs.statSync(abs)
  if (stat.isFile()) {
    scanFile(abs)
    return
  }
  if (EXCLUDE.test(abs)) return
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    walk(path.join(target, entry.name))
  }
}

for (const target of roots) walk(target)

if (hits.length) {
  console.error(`[release-check] FAIL (${mode}) — 发现 ${hits.length} 处开发者本地信息，禁止发布：`)
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}  [${hit.label}]  ${hit.text}`)
  }
  process.exit(1)
}

if (scanned === 0) {
  console.error(`[release-check] FAIL (${mode}) — 扫描到 0 个文件，拒绝空扫描通过。`)
  process.exit(1)
}

console.log(`[release-check] PASS (${mode}) — scanned ${scanned} files, no matches for the limited rules.`)

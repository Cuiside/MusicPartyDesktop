#!/usr/bin/env node
/**
 * 合并多个 label 目录中的 suite-*.json 为一份 SUMMARY.json（用于分批执行/中断续跑）。
 *
 * 用法：
 *   node tests/regression/merge-results.mjs --label <输出label> --inputs <label1,label2,...>
 *   例：node tests/regression/merge-results.mjs --label baseline-old-jar \
 *         --inputs baseline-old-jar,s08s09-old-baseline,s10s11-old-baseline
 *
 * 后出现的 label 中同 id suite 覆盖前面的（用于重跑单个 suite 后合并）。
 * 输出写入 E:\example-delivery\verification\<label>\SUMMARY.json，并复制到
 * docs/verification/results-<label>.json。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DOCS_VERIFICATION_ROOT, VERIFICATION_ROOT, ensureDir, nowIso, parseArgs } from './lib/env.mjs'

const args = parseArgs()
const label = String(args.label || '')
const inputs = String(args.inputs || label)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

if (!label || !inputs.length) {
  console.error('用法：--label <输出label> --inputs <label1,label2,...>')
  process.exitCode = 1
  process.exit(0)
}

const outDir = path.join(VERIFICATION_ROOT, label)
ensureDir(outDir)

const suitesById = new Map()
const envMetaByLabel = {}
let firstEnv = null

for (const inputLabel of inputs) {
  const dir = path.join(VERIFICATION_ROOT, inputLabel)
  if (!fs.existsSync(dir)) {
    console.warn(`[merge] 跳过不存在的目录：${dir}`)
    continue
  }
  const files = fs.readdirSync(dir).filter((file) => /^suite-.*\.json$/.test(file))
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    if (!data?.suiteId) continue
    const merged = { ...data, sourceLabel: inputLabel }
    suitesById.set(data.suiteId, merged)
  }
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'SUMMARY.json'), 'utf8'))
    if (!firstEnv && summary.env) firstEnv = summary.env
    envMetaByLabel[inputLabel] = summary.env || null
  } catch {
    envMetaByLabel[inputLabel] = null
  }
}

// Recompute the failed check list from the FINAL (overridden) suite data only.
const failedChecks = []
for (const data of suitesById.values()) {
  for (const check of data.checks || []) {
    if (!check.pass && !check.skipped) {
      failedChecks.push({ suite: data.suiteId, id: check.id, expected: check.expected, actual: check.actual })
    }
  }
}

const suites = [...suitesById.values()].map((data) => {
  const passed = (data.checks || []).filter((check) => !check.skipped && check.pass).length
  const failed = (data.checks || []).filter((check) => !check.skipped && !check.pass).length
  const skipped = (data.checks || []).filter((check) => check.skipped).length
  return {
    suite: data.suiteId,
    title: data.suiteTitle,
    total: (data.checks || []).length,
    passed,
    failed,
    skipped,
    file: path.join(VERIFICATION_ROOT, data.sourceLabel, `suite-${data.suiteId}.json`)
  }
})

const totals = suites.reduce(
  (acc, suite) => ({
    total: acc.total + suite.total,
    passed: acc.passed + suite.passed,
    failed: acc.failed + suite.failed,
    skipped: acc.skipped + suite.skipped
  }),
  { total: 0, passed: 0, failed: 0, skipped: 0 }
)

const payload = {
  env: {
    ...(firstEnv || {}),
    label,
    mergedAt: nowIso(),
    inputs,
    note: '由 merge-results.mjs 合并；各 suite 的 level 字段标注证据等级（real-jar / unit / static-source / mock-http/upstream）。'
  },
  finishedAt: nowIso(),
  totals,
  suites,
  failedChecks
}
const summaryFile = path.join(outDir, 'SUMMARY.json')
fs.writeFileSync(summaryFile, JSON.stringify(payload, null, 2))
const docsCopy = path.join(DOCS_VERIFICATION_ROOT, `results-${label}.json`)
ensureDir(DOCS_VERIFICATION_ROOT)
fs.writeFileSync(docsCopy, JSON.stringify(payload, null, 2))
console.log(`merged ${inputs.join(', ')} -> ${summaryFile}`)
console.log(JSON.stringify(totals))
console.log(`docs copy -> ${docsCopy}`)

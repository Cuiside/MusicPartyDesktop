#!/usr/bin/env node
/**
 * MusicParty 独立回归测试入口（verifier 资产）。
 *
 * 用法：
 *   node tests/regression/run-all.mjs --jar <server.jar> [--java <java.exe>]
 *        [--label old-baseline|new-fix] [--only s01,s02] [--strict] [--list]
 *
 * 说明：
 *  - 每个 suite 独立启动隔离 Java 进程（127.0.0.1:18848、合成上游 :18849、临时数据目录），
 *    结束后强制清理进程与端口；不接触生产/共享房间。
 *  - 每个 check 带 expected/actual/pass/evidence/level，结果写入
 *    E:\example-delivery\verification\<label>\suite-*.json 与 SUMMARY.json，并复制到
 *    E:\example-desktop\docs\verification\results-<label>.json。
 *  - 默认退出码 0（基线模式即使断言 FAIL 也完成采集）；--strict 时任一非 skip FAIL 返回 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DESKTOP_ROOT,
  DELIVERY_ROOT,
  DOCS_VERIFICATION_ROOT,
  VERIFICATION_ROOT,
  ensureDir,
  isOldJar,
  isPortListening,
  nowIso,
  parseArgs,
  resolveJar,
  resolveJava,
  run,
  sha256File,
  tmpRoot,
  waitPortFree,
  DEFAULT_SERVER_PORT,
  UPSTREAM_PORT
} from './lib/env.mjs'
import { Collector, writeRunSummary, writeSuiteResult } from './lib/results.mjs'

const SUITE_MODULES = [
  './suites/s01-playable.mjs',
  './suites/s02-identity.mjs',
  './suites/s05-s06-cookie.mjs',
  './suites/s07-room-rest.mjs',
  './suites/s08-validation.mjs',
  './suites/s09-ratelimit.mjs',
  './suites/s10-d06-ping.mjs',
  './suites/s11-d15-ack.mjs',
  './suites/s12-d09-blank-admin.mjs',
  './suites/o03-cookie-normalization.mjs',
  './suites/s13-client-integration.mjs',
  './suites/desktop-pure.mjs'
]

async function loadSuites(only) {
  const wanted = only
    ? String(only)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : null
  const suites = []
  for (const modulePath of SUITE_MODULES) {
    const fullPath = new URL(modulePath, import.meta.url)
    if (!fs.existsSync(fullPath)) continue
    const mod = await import(fullPath)
    if (!mod.id || typeof mod.run !== 'function') continue
    if (wanted && !wanted.some((token) => mod.id.includes(token) || token.includes(mod.id))) continue
    suites.push(mod)
  }
  return suites
}

async function main() {
  const args = parseArgs()
  const jar = resolveJar(args)
  if (!fs.existsSync(jar)) throw new Error(`找不到测试 JAR：${jar}`)
  const java = resolveJava(args)
  if (!fs.existsSync(java)) throw new Error(`找不到 Java：${java}`)

  const jarSha = sha256File(jar)
  const baseline = isOldJar(jar)
  const label = String(args.label || (baseline ? 'baseline-old-jar' : `new-jar-${jarSha.slice(0, 12).toLowerCase()}`))
  const outDir = path.join(VERIFICATION_ROOT, label)
  ensureDir(outDir)

  const suites = await loadSuites(args.only)
  if (args.list) {
    console.log(JSON.stringify(suites.map((suite) => ({ id: suite.id, title: suite.title })), null, 2))
    return
  }
  if (!suites.length) throw new Error('没有匹配的 suite（检查 --only）')

  const javaVersion = await run(java, ['-version'])
  const envMeta = {
    label,
    startedAt: nowIso(),
    host: process.env.COMPUTERNAME || 'unknown',
    platform: process.platform,
    release: process.env.OS || '',
    node: process.version,
    java,
    javaVersion: `${javaVersion.stdout}${javaVersion.stderr}`.trim().split(/\r?\n/)[0] || '',
    jar,
    jarSha256: jarSha,
    baseline,
    ports: { server: DEFAULT_SERVER_PORT, upstream: UPSTREAM_PORT },
    protocolContract: path.join(DELIVERY_ROOT, 'PROTOCOL_V2.md'),
    note: '所有断言针对 PROTOCOL_V2.md 冻结契约/审计确认的正确行为；level 字段标注证据等级。'
  }

  console.log(`\n=== MusicParty regression run ===\nlabel=${label}\njar=${jar}\nsha256=${jarSha}\njava=${java}\n`)
  const summarySuites = []
  const runTmp = tmpRoot('mp-regression-run-')

  for (const suite of suites) {
    console.log(`\n--- ${suite.id}: ${suite.title} ---`)
    const collector = new Collector(suite.id, suite.title, { label, jarSha256: jarSha })
    const cleanups = []
    const ctx = {
      args,
      jar,
      java,
      jarSha256: jarSha,
      baseline,
      label,
      outDir,
      collector,
      /** Create a fresh temporary data directory for an isolated server. */
      makeDataDir: (name) => fs.mkdtempSync(path.join(runTmp, `${suite.id}-${name}-`)),
      onCleanup: (fn) => cleanups.push(fn)
    }
    try {
      await suite.run(ctx)
    } catch (error) {
      collector.add({
        id: `${suite.id}-fatal`,
        title: 'suite 执行异常（非断言失败，需人工查看）',
        expected: 'suite 正常执行完毕',
        actual: String(error?.stack || error).slice(0, 4000),
        pass: false,
        level: 'harness'
      })
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          console.warn(`[cleanup] ${suite.id}: ${error?.message || error}`)
        }
      }
      // Guarantee the shared ports are free before the next suite starts.
      await waitPortFree(DEFAULT_SERVER_PORT, 12000)
      await waitPortFree(UPSTREAM_PORT, 12000)
    }
    const resultFile = writeSuiteResult(outDir, collector)
    summarySuites.push({ ...collector.summary(), file: resultFile })
    console.log(`[suite] ${suite.id}: ${JSON.stringify(collector.summary())}`)
    // Persist an incremental rollup so an interrupted long run still leaves valid evidence.
    try {
      fs.writeFileSync(
        path.join(outDir, 'PARTIAL.json'),
        JSON.stringify(
          {
            env: envMeta,
            updatedAt: nowIso(),
            suites: summarySuites,
            totals: summarySuites.reduce(
              (acc, suite) => ({
                total: acc.total + suite.total,
                passed: acc.passed + suite.passed,
                failed: acc.failed + suite.failed,
                skipped: acc.skipped + suite.skipped
              }),
              { total: 0, passed: 0, failed: 0, skipped: 0 }
            )
          },
          null,
          2
        )
      )
    } catch {
      /* rollup is best-effort */
    }
  }

  const finishedAt = nowIso()
  const totals = summarySuites.reduce(
    (acc, suite) => ({
      total: acc.total + suite.total,
      passed: acc.passed + suite.passed,
      failed: acc.failed + suite.failed,
      skipped: acc.skipped + suite.skipped
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0 }
  )
  const payload = {
    env: envMeta,
    finishedAt,
    totals,
    suites: summarySuites,
    failedChecks: summarySuites.length
      ? (() => {
          const failed = []
          for (const suite of suites) {
            const file = path.join(outDir, `suite-${suite.id}.json`)
            try {
              const data = JSON.parse(fs.readFileSync(file, 'utf8'))
              for (const check of data.checks || []) {
                if (!check.pass && !check.skipped) {
                  failed.push({ suite: suite.id, id: check.id, expected: check.expected, actual: check.actual })
                }
              }
            } catch {
              /* ignore */
            }
          }
          return failed
        })()
      : []
  }
  const thirdParty = path.join(DOCS_VERIFICATION_ROOT, `results-${label}.json`)
  const summaryFile = writeRunSummary(outDir, payload, thirdParty)
  console.log(`\n=== SUMMARY ===\n${JSON.stringify(totals)}\nfiles:\n  ${summaryFile}\n  ${thirdParty}`)

  const failures = totals.failed
  if (args.strict && failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`[fatal] ${error?.stack || error}`)
  process.exitCode = 1
})

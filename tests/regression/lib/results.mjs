/**
 * Assertion collector + result writer for the MusicParty regression suite.
 *
 * A check always carries: id, title, expected, actual, pass, evidence, level.
 * `expected` is the protocol-v2 expectation (E:\example-delivery\PROTOCOL_V2.md) or the
 * audited-correct behavior; any deviation is a FAIL, never silently a pass.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, nowIso } from './env.mjs'

/** Evidence levels — keep them explicit so the report cannot overclaim. */
export const LEVEL = {
  UNIT: 'unit',
  STATIC: 'static-source',
  MOCK: 'mock-http/upstream',
  REAL_JAR: 'real-jar',
  REAL_JAR_RESTART: 'real-jar+restart',
  ELECTRON: 'real-electron',
  PACKAGE: 'packaged-artifact'
}

/** Structural deep equality good enough for JSON fixtures. */
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((key) => deepEqual(a[key], b[key]))
  }
  return Number.isNaN(a) && Number.isNaN(b)
}

/**
 * Assertion comparison used by Collector.expect:
 *  - scalar expected  → strict equality (Object.is semantics);
 *  - array expected   → whole-array strict equality (declare the full expected array);
 *  - object expected  → **deep subset**: `actual` must contain every expected key with a
 *    matching value; extra actual keys (diagnostic fields such as ids/status aliases) are
 *    allowed. This keeps assertions explicit without failing on harmless extra evidence.
 */
export function matchesExpected(expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false
    return expected.every((value, index) => matchesExpected(value, actual[index]))
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.keys(expected).every((key) => key in actual && matchesExpected(expected[key], actual[key]))
  }
  return Object.is(expected, actual)
}

function short(value, max = 400) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = String(value)
  return text.length > max ? `${text.slice(0, max)}…[len=${text.length}]` : text
}

export class Collector {
  constructor(suiteId, suiteTitle, meta = {}) {
    this.suiteId = suiteId
    this.suiteTitle = suiteTitle
    this.meta = meta
    this.checks = []
    this.startedAt = nowIso()
  }

  /** Record one explicit check. */
  add({ id, title, expected, actual, pass, evidence = null, level = LEVEL.REAL_JAR, skipped = false, note = '' }) {
    const check = {
      id,
      title: title || '',
      expected,
      actual,
      pass: Boolean(pass),
      skipped: Boolean(skipped),
      level,
      evidence: evidence === undefined ? null : evidence,
      note,
      at: nowIso()
    }
    this.checks.push(check)
    const tag = check.skipped ? 'SKIP' : check.pass ? 'PASS' : 'FAIL'
    console.log(`[${tag}] ${this.suiteId}/${id} expected=${short(expected, 240)} actual=${short(actual, 240)}${note ? ` (${note})` : ''}`)
    return check
  }

  /** Primary assertion: compare `actual` against `expected` (object = deep subset). */
  expect(id, {
    title = '',
    expected,
    actual,
    evidence,
    level,
    note = ''
  } = {}) {
    return this.add({ id, title, expected, actual, pass: matchesExpected(expected, actual), evidence, level, note })
  }

  /** Assertion on a boolean predicate with human-readable expected/actual. */
  assert(id, { title = '', expected = true, condition, actual, evidence, level, note = '' } = {}) {
    return this.add({
      id,
      title,
      expected,
      actual: actual === undefined ? (condition ? 'condition met' : 'condition not met') : actual,
      pass: Boolean(condition),
      evidence,
      level,
      note
    })
  }

  /** Mark a required check as not verifiable; never counts as a pass. */
  skip(id, { title = '', expected = '', reason, evidence, level } = {}) {
    return this.add({ id, title, expected, actual: `未验证：${reason}`, pass: false, skipped: true, evidence, level })
  }

  /** Convenience: expectation of a numeric/string field with predicate. */
  expectMatch(id, { title = '', expected, actual, matcher, evidence, level, note = '' }) {
    return this.add({ id, title, expected, actual, pass: Boolean(matcher(actual)), evidence, level, note })
  }

  summary() {
    const total = this.checks.length
    const passed = this.checks.filter((c) => !c.skipped && c.pass).length
    const failed = this.checks.filter((c) => !c.skipped && !c.pass).length
    const skipped = this.checks.filter((c) => c.skipped).length
    return { suite: this.suiteId, title: this.suiteTitle, total, passed, failed, skipped }
  }

  toJSON() {
    return {
      suiteId: this.suiteId,
      suiteTitle: this.suiteTitle,
      startedAt: this.startedAt,
      finishedAt: nowIso(),
      meta: this.meta,
      summary: this.summary(),
      checks: this.checks
    }
  }
}

/** Write one suite result JSON to the delivery verification directory. */
export function writeSuiteResult(outDir, collector) {
  ensureDir(outDir)
  const file = path.join(outDir, `suite-${collector.suiteId}.json`)
  fs.writeFileSync(file, JSON.stringify(collector.toJSON(), null, 2))
  return file
}

/** Write the run summary JSON (invoked by run-all.mjs). */
export function writeRunSummary(outDir, payload, docsCopyFile = null) {
  ensureDir(outDir)
  const file = path.join(outDir, 'SUMMARY.json')
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  if (docsCopyFile) {
    ensureDir(path.dirname(docsCopyFile))
    fs.writeFileSync(docsCopyFile, JSON.stringify(payload, null, 2))
  }
  return file
}

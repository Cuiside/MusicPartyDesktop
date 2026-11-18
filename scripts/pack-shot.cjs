'use strict'

/**
 * 验证打包产物（<out>/<variant>/win-unpacked）能真实启动并渲染出画面。
 *
 * 用法：
 *   node scripts/pack-shot.cjs [--variant remote|local-server] [--out release-new] [--exe <path>] [png]
 *   node scripts/pack-shot.cjs screenshots/qa/packaged-remote.png --variant remote
 *
 * 默认：variant=remote，out=release-new → release-new/remote/win-unpacked/Music Party.exe
 * 兼容旧行为：找不到新路径且未显式传参时，回退 release/win-unpacked。
 *
 * 用主进程已有的无窗口截图模式（MP_SHOT=1）拉起打包后的 exe：
 *   - 不显示窗口（showInactive + opacity 0），不会弹出 UI 干扰
 *   - 4s 后 capturePage 写 PNG，然后 app.exit(0)
 * 本脚本校验：exe 存在 → 进程正常退出 → PNG 存在且尺寸合法。
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TIMEOUT_MS = 120000
const VARIANTS = new Set(['remote', 'local-server'])

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value == null || value.startsWith('--') ? fallback : value
}

const variant = readFlag('--variant', 'remote')
if (!VARIANTS.has(variant)) {
  console.error(`未知变体：${variant}（仅支持 remote / local-server）`)
  process.exit(2)
}
const outRoot = path.resolve(ROOT, readFlag('--out', 'release-new'))
const explicitExe = readFlag('--exe', '')
const positional = process.argv.slice(2).filter((arg, index, list) => {
  if (arg.startsWith('--')) return false
  const prev = list[index - 1]
  return !(prev === '--variant' || prev === '--out' || prev === '--exe')
})
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const exeName = ((pkg.build && (pkg.build.executableName || pkg.build.productName)) || 'Music Party') + '.exe'
const canonicalExe = path.join(outRoot, variant, 'win-unpacked', exeName)
const legacyExe = path.join(ROOT, 'release', 'win-unpacked', exeName)
const EXE = explicitExe
  ? path.resolve(ROOT, explicitExe)
  : fs.existsSync(canonicalExe)
    ? canonicalExe
    : legacyExe

const outArg = positional[0] || `screenshots/qa/packaged-${variant}.png`
const outPath = path.resolve(ROOT, outArg)
const LOG_DIR = path.join(outRoot, 'logs')

function readPngSize(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function fail(message, tail) {
  console.error(`\n[verify] ✖ ${message}`)
  if (tail) {
    console.error('[verify] exe 输出（尾部 40 行）：')
    console.error(tail.split(/\r?\n/).slice(-40).join('\n'))
  }
  process.exit(1)
}

function main() {
  if (!fs.existsSync(EXE)) {
    fail(
      `找不到打包产物 ${path.relative(ROOT, EXE)}；请先执行 ` +
        `node scripts/pack.cjs --dir --variant ${variant} --out ${path.relative(ROOT, outRoot)}`
    )
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.rmSync(outPath, { force: true }) // 清除旧图，确保校验的是本次启动的结果
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const logFile = path.join(LOG_DIR, `pack-verify-${variant}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const log = fs.createWriteStream(logFile, { flags: 'a' })

  const env = { ...process.env }
  // ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node（不出窗口、无截图），必须移除。
  delete env.ELECTRON_RUN_AS_NODE
  env.MP_SHOT = '1'
  env.MP_SHOT_OUT = outPath
  env.MP_SHOT_WAIT = env.MP_SHOT_WAIT || '4000'

  console.log(`[verify] variant = ${variant}`)
  console.log(`[verify] exe     = ${path.relative(ROOT, EXE)}`)
  console.log(`[verify] shot    = ${path.relative(ROOT, outPath)}`)
  console.log(`[verify] env     = MP_SHOT=1 MP_SHOT_WAIT=${env.MP_SHOT_WAIT}（已移除 ELECTRON_RUN_AS_NODE）`)

  const child = spawn(EXE, [], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let captured = ''
  const forward = (stream) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      captured += text
      process.stdout.write(text)
      log.write(text)
    })
  }
  forward(child.stdout)
  forward(child.stderr)

  const startedAt = Date.now()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    console.error(`[verify] ✖ ${TIMEOUT_MS / 1000}s 内未退出，强制结束进程`)
    child.kill()
  }, TIMEOUT_MS)

  child.on('error', (error) => {
    clearTimeout(timer)
    log.end()
    fail(`无法启动 exe：${error?.message || error}`, captured)
  })

  child.on('close', (code) => {
    clearTimeout(timer)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    log.end()
    if (timedOut) fail(`启动超时（${seconds}s）`, captured)

    if (!fs.existsSync(outPath)) {
      fail(`进程已退出（code=${code}）但没有生成 PNG（耗时 ${seconds}s）`, captured)
    }
    const png = fs.readFileSync(outPath)
    const size = readPngSize(png)
    if (!size) fail(`输出文件不是合法 PNG：${path.relative(ROOT, outPath)}`, captured)
    if (size.width < 1024 || size.height < 600) {
      fail(`PNG 尺寸异常：${size.width}x${size.height}`, captured)
    }
    if (code !== 0) fail(`exe 退出码 ${code}（期望 0）`, captured)

    const result = {
      ok: true,
      variant,
      exe: path.relative(ROOT, EXE).replace(/\\/g, '/'),
      png: path.relative(ROOT, outPath).replace(/\\/g, '/'),
      bytes: png.length,
      width: size.width,
      height: size.height,
      exitCode: code,
      seconds: Number(seconds),
      log: path.relative(ROOT, logFile).replace(/\\/g, '/')
    }
    console.log(`\n[verify] ✔ 打包产物启动成功并渲染出画面：${JSON.stringify(result)}`)
    process.exit(0)
  })
}

if (require.main === module) main()

module.exports = { readPngSize }
